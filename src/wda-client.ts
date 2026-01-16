export interface WDAStatus {
  ready: boolean;
  message?: string;
  state?: string;
  os?: {
    name: string;
    version: string;
  };
  build?: {
    time: string;
  };
}

export interface WDASession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export class WDAClient {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl: string = "http://localhost:8100") {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WDA request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data as T;
  }

  // Get WDA status
  async getStatus(): Promise<WDAStatus> {
    const response = await this.request<{ value: WDAStatus }>("GET", "/status");
    return {
      ...response.value,
      ready: response.value.ready ?? true,
    };
  }

  // Create a new session
  async createSession(
    capabilities: Record<string, unknown> = {}
  ): Promise<string> {
    const response = await this.request<{ value: WDASession }>(
      "POST",
      "/session",
      {
        capabilities: {
          alwaysMatch: capabilities,
          firstMatch: [{}],
        },
      }
    );
    this.sessionId = response.value.sessionId;
    return this.sessionId;
  }

  // Delete current session
  async deleteSession(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.request("DELETE", `/session/${this.sessionId}`);
      } catch {
        // Ignore errors when deleting session
      }
      this.sessionId = null;
    }
  }

  // Get the current session ID (create one if needed)
  async ensureSession(): Promise<string> {
    if (!this.sessionId) {
      await this.createSession();
    }
    return this.sessionId!;
  }

  // Get page source (accessibility tree) as XML
  async getSource(): Promise<string> {
    const sessionId = await this.ensureSession();
    const response = await this.request<{ value: string }>(
      "GET",
      `/session/${sessionId}/source`
    );
    return response.value;
  }

  // Get screenshot as base64 PNG
  async screenshot(): Promise<string> {
    const sessionId = await this.ensureSession();
    const response = await this.request<{ value: string }>(
      "GET",
      `/session/${sessionId}/screenshot`
    );
    return response.value;
  }

  // Get screenshot as Buffer
  async screenshotBuffer(): Promise<Buffer> {
    const base64 = await this.screenshot();
    return Buffer.from(base64, "base64");
  }

  // Find element by various strategies
  async findElement(
    using: string,
    value: string
  ): Promise<{ ELEMENT: string } | null> {
    const sessionId = await this.ensureSession();
    try {
      const response = await this.request<{ value: { ELEMENT: string } }>(
        "POST",
        `/session/${sessionId}/element`,
        { using, value }
      );
      return response.value;
    } catch {
      return null;
    }
  }

  // Find elements by various strategies
  async findElements(
    using: string,
    value: string
  ): Promise<Array<{ ELEMENT: string }>> {
    const sessionId = await this.ensureSession();
    try {
      const response = await this.request<{
        value: Array<{ ELEMENT: string }>;
      }>("POST", `/session/${sessionId}/elements`, { using, value });
      return response.value;
    } catch {
      return [];
    }
  }

  // Click element
  async click(elementId: string): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${sessionId}/element/${elementId}/click`
    );
  }

  // Type into element
  async type(elementId: string, text: string): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${sessionId}/element/${elementId}/value`,
      { value: text.split("") }
    );
  }

  // Clear element
  async clear(elementId: string): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${sessionId}/element/${elementId}/clear`
    );
  }

  // Get alert text (if present)
  async getAlertText(): Promise<string | null> {
    const sessionId = await this.ensureSession();
    try {
      const response = await this.request<{ value: string }>(
        "GET",
        `/session/${sessionId}/alert/text`
      );
      return response.value;
    } catch {
      return null;
    }
  }

  // Accept alert
  async acceptAlert(): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request("POST", `/session/${sessionId}/alert/accept`);
  }

  // Dismiss alert
  async dismissAlert(): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request("POST", `/session/${sessionId}/alert/dismiss`);
  }

  // Launch app
  async launchApp(bundleId: string): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request("POST", `/session/${sessionId}/wda/apps/launch`, {
      bundleId,
    });
  }

  // Terminate app
  async terminateApp(bundleId: string): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request("POST", `/session/${sessionId}/wda/apps/terminate`, {
      bundleId,
    });
  }

  // Get active app info
  async getActiveAppInfo(): Promise<{ bundleId: string; name: string } | null> {
    const sessionId = await this.ensureSession();
    try {
      const response = await this.request<{
        value: { bundleId: string; name: string };
      }>("GET", `/session/${sessionId}/wda/activeAppInfo`);
      return response.value;
    } catch {
      return null;
    }
  }

  // Swipe on element
  async swipe(
    elementId: string,
    direction: "up" | "down" | "left" | "right"
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    await this.request(
      "POST",
      `/session/${sessionId}/wda/element/${elementId}/swipe`,
      { direction }
    );
  }

  // Swipe on screen (without element)
  async swipeScreen(
    direction: "up" | "down" | "left" | "right"
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    // Use touch actions for screen swipe
    const windowSize = { width: 390, height: 844 }; // Default iPhone size

    let fromX: number, fromY: number, toX: number, toY: number;
    const centerX = windowSize.width / 2;
    const centerY = windowSize.height / 2;
    const offset = 200;

    switch (direction) {
      case "up":
        fromX = centerX;
        fromY = centerY + offset;
        toX = centerX;
        toY = centerY - offset;
        break;
      case "down":
        fromX = centerX;
        fromY = centerY - offset;
        toX = centerX;
        toY = centerY + offset;
        break;
      case "left":
        fromX = centerX + offset;
        fromY = centerY;
        toX = centerX - offset;
        toY = centerY;
        break;
      case "right":
        fromX = centerX - offset;
        fromY = centerY;
        toX = centerX + offset;
        toY = centerY;
        break;
    }

    await this.request("POST", `/session/${sessionId}/wda/touch/perform`, {
      actions: [
        { action: "press", options: { x: fromX, y: fromY } },
        { action: "wait", options: { ms: 100 } },
        { action: "moveTo", options: { x: toX, y: toY } },
        { action: "release" },
      ],
    });
  }
}
