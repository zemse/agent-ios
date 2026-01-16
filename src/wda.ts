import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Default WDA path
const getWDAPath = (): string => {
  return process.env.WDA_PATH || path.join(os.homedir(), "WebDriverAgent");
};

// Default WDA port
const getWDAPort = (): number => {
  return parseInt(process.env.WDA_PORT || "8100", 10);
};

export class WDAManager {
  private process: ChildProcess | null = null;
  private udid: string;
  private port: number;
  private wdaPath: string;

  constructor(udid: string, port: number = getWDAPort()) {
    this.udid = udid;
    this.port = port;
    this.wdaPath = getWDAPath();
  }

  get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  // Check if WDA project exists
  private checkWDAExists(): void {
    const projectPath = path.join(this.wdaPath, "WebDriverAgent.xcodeproj");
    if (!fs.existsSync(projectPath)) {
      throw new Error(
        `WebDriverAgent not found at ${this.wdaPath}. ` +
          `Clone it with: git clone https://github.com/appium/WebDriverAgent.git ${this.wdaPath} ` +
          `or set WDA_PATH environment variable.`
      );
    }
  }

  // Start WDA process
  async start(): Promise<void> {
    if (this.process) {
      throw new Error("WDA is already running");
    }

    this.checkWDAExists();

    return new Promise((resolve, reject) => {
      // Build and run WDA
      const args = [
        "-project",
        path.join(this.wdaPath, "WebDriverAgent.xcodeproj"),
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `platform=iOS Simulator,id=${this.udid}`,
        "-derivedDataPath",
        path.join(this.wdaPath, "DerivedData"),
        "test",
      ];

      this.process = spawn("xcodebuild", args, {
        cwd: this.wdaPath,
        env: {
          ...process.env,
          USE_PORT: this.port.toString(),
        },
      });

      let output = "";
      let resolved = false;

      const onData = (data: Buffer) => {
        const text = data.toString();
        output += text;

        // WDA prints "ServerURLHere" when ready
        if (text.includes("ServerURLHere") || text.includes(`http://[::1]:${this.port}`)) {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }
      };

      this.process.stdout?.on("data", onData);
      this.process.stderr?.on("data", onData);

      this.process.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to start WDA: ${err.message}`));
        }
      });

      this.process.on("close", (code) => {
        this.process = null;
        if (!resolved) {
          resolved = true;
          // Extract relevant error info from output
          const errorLines = output
            .split("\n")
            .filter((line) => line.includes("error:") || line.includes("Error:"))
            .slice(-5)
            .join("\n");
          reject(
            new Error(
              `WDA process exited with code ${code}. ${errorLines || "Check Xcode setup."}`
            )
          );
        }
      });

      // Timeout after 120 seconds (WDA build can take a while)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stop();
          reject(new Error("WDA startup timed out after 120s. Check Xcode and simulator."));
        }
      }, 120000);
    });
  }

  // Stop WDA process
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        if (!this.process) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process.on("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }
  }

  // Check if WDA is running and responsive
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Wait for WDA to be ready
  async waitForReady(timeout: number = 60000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeout) {
      if (await this.isRunning()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`WDA did not become ready within ${timeout / 1000}s`);
  }
}
