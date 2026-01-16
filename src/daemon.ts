import * as fs from "fs";
import {
  type Command,
  type Response,
  getSocketPath,
  getPidPath,
  getSessionName,
  successResponse,
  errorResponse,
} from "./protocol.js";
import { SocketServer } from "./socket-server.js";
import {
  listSimulators,
  findSimulator,
  bootSimulator,
  openSimulatorApp,
  getBootedSimulator,
  installApp,
  type Simulator,
} from "./simctl.js";
import { WDAManager } from "./wda.js";
import { WDAClient } from "./wda-client.js";
import {
  parseWDASource,
  createRefStore,
  resolveRef,
  RefResolutionError,
  type RefStore,
} from "./snapshot.js";

// Session state
interface SessionState {
  simulator: Simulator | null;
  wdaManager: WDAManager | null;
  wdaClient: WDAClient | null;
  refStore: RefStore;
  startedAt: Date;
}

const state: SessionState = {
  simulator: null,
  wdaManager: null,
  wdaClient: null,
  refStore: createRefStore(),
  startedAt: new Date(),
};

// Command handler
const handleCommand = async (command: Command): Promise<Response> => {
  switch (command.action) {
    case "start-session":
      return handleStartSession(command.id, command.sim);

    case "stop-session":
      return handleStopSession(command.id);

    case "status":
      return handleStatus(command.id);

    case "list-sims":
      return handleListSims(command.id);

    case "snapshot":
      return handleSnapshot(command.id);

    case "screenshot":
      return handleScreenshot(command.id, command.out);

    case "tap":
      return handleTap(command.id, command.ref);

    case "type":
      return handleType(command.id, command.ref, command.text);

    case "clear":
      return handleClear(command.id, command.ref);

    case "swipe":
      return handleSwipe(command.id, command.ref, command.direction);

    case "wait":
      return handleWait(command.id, command.ref, command.timeout);

    case "alert-accept":
      return handleAlertAccept(command.id);

    case "alert-dismiss":
      return handleAlertDismiss(command.id);

    case "alert-button":
      return handleAlertButton(command.id, command.button);

    case "launch":
      return handleLaunch(command.id, command.bundleId);

    case "terminate":
      return handleTerminate(command.id, command.bundleId);

    case "install":
      return handleInstall(command.id, command.appPath);

    default: {
      const _exhaustiveCheck: never = command;
      return errorResponse((_exhaustiveCheck as Command).id, `Unknown action`);
    }
  }
};

const handleStartSession = async (
  id: string,
  simName?: string
): Promise<Response> => {
  try {
    let simulator: Simulator | null = null;

    if (simName) {
      simulator = findSimulator(simName);
      if (!simulator) {
        return errorResponse(
          id,
          `Simulator not found: ${simName}. Run 'agent-ios list-sims' to see available simulators.`
        );
      }
    } else {
      simulator = getBootedSimulator();
      if (!simulator) {
        const sims = listSimulators();
        if (sims.length === 0) {
          return errorResponse(
            id,
            "No simulators available. Install Xcode and create a simulator."
          );
        }
        simulator = sims.find((s) => s.name.includes("iPhone")) || sims[0];
      }
    }

    // Boot if needed
    if (simulator.state !== "Booted") {
      await bootSimulator(simulator.udid);
      await openSimulatorApp();
      simulator = { ...simulator, state: "Booted" };
    }

    state.simulator = simulator;

    // Start WDA
    console.error(`Starting WebDriverAgent for ${simulator.name}...`);
    state.wdaManager = new WDAManager(simulator.udid);

    try {
      await state.wdaManager.start();
      console.error("WDA started, verifying HTTP endpoint...");

      // Quick sanity check - WDA should already be ready after start() resolves
      await state.wdaManager.waitForReady(10000);
      console.error("WDA is ready!");

      // Create WDA client
      state.wdaClient = new WDAClient(state.wdaManager.baseUrl);

      // Create session
      await state.wdaClient.createSession();
      console.error("WDA session created");
    } catch (wdaError) {
      // Clean up WDA on failure
      if (state.wdaManager) {
        await state.wdaManager.stop();
        state.wdaManager = null;
      }
      state.wdaClient = null;

      return errorResponse(
        id,
        `Simulator booted but WDA failed: ${wdaError instanceof Error ? wdaError.message : "Unknown error"}`
      );
    }

    return successResponse(id, {
      simulator: {
        name: simulator.name,
        udid: simulator.udid,
        runtime: simulator.runtime,
      },
      wda: {
        url: state.wdaManager.baseUrl,
        ready: true,
      },
      message: `Session started with ${simulator.name}`,
    });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to start session: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleStopSession = async (id: string): Promise<Response> => {
  try {
    // Stop WDA
    if (state.wdaClient) {
      try {
        await state.wdaClient.deleteSession();
      } catch {
        // Ignore session deletion errors
      }
      state.wdaClient = null;
    }

    if (state.wdaManager) {
      await state.wdaManager.stop();
      state.wdaManager = null;
    }

    // Clear refs
    state.refStore.clear();

    if (state.simulator) {
      state.simulator = null;
    }

    // Signal daemon to stop
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 100);

    return successResponse(id, { message: "Session stopped" });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to stop session: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleStatus = async (id: string): Promise<Response> => {
  let booted: Simulator | null = null;
  try {
    booted = getBootedSimulator();
  } catch {
    // simctl not available
  }

  let wdaRunning = false;
  if (state.wdaManager) {
    wdaRunning = await state.wdaManager.isRunning();
  }

  return successResponse(id, {
    running: true,
    session: getSessionName(),
    uptime: Math.floor((Date.now() - state.startedAt.getTime()) / 1000),
    simulator: state.simulator
      ? {
          name: state.simulator.name,
          udid: state.simulator.udid,
          runtime: state.simulator.runtime,
        }
      : null,
    wda: state.wdaManager
      ? {
          url: state.wdaManager.baseUrl,
          running: wdaRunning,
        }
      : null,
    bootedSimulator: booted
      ? {
          name: booted.name,
          udid: booted.udid,
          runtime: booted.runtime,
        }
      : null,
  });
};

const handleListSims = async (id: string): Promise<Response> => {
  try {
    const simulators = listSimulators();
    return successResponse(id, {
      simulators: simulators.map((s) => ({
        name: s.name,
        udid: s.udid,
        state: s.state,
        runtime: s.runtime,
      })),
    });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to list simulators: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleSnapshot = async (id: string): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    // Get source XML from WDA
    const xml = await state.wdaClient.getSource();

    // Parse to our JSON format
    const snapshot = parseWDASource(xml);

    // Update ref store
    state.refStore.clear();
    for (const [ref, entry] of Object.entries(snapshot.refMap)) {
      state.refStore.set(ref, entry);
    }

    return successResponse(id, snapshot);
  } catch (err) {
    return errorResponse(
      id,
      `Failed to get snapshot: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleScreenshot = async (
  id: string,
  outPath?: string
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    if (outPath) {
      // Save to file
      const buffer = await state.wdaClient.screenshotBuffer();
      fs.writeFileSync(outPath, buffer);
      return successResponse(id, {
        saved: true,
        path: outPath,
        size: buffer.length,
      });
    } else {
      // Return base64
      const base64 = await state.wdaClient.screenshot();
      return successResponse(id, {
        format: "base64",
        data: base64,
      });
    }
  } catch (err) {
    return errorResponse(
      id,
      `Failed to take screenshot: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleTap = async (id: string, ref: string): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const elementId = await resolveRef(
      ref,
      state.refStore,
      state.wdaClient.findElement.bind(state.wdaClient)
    );
    await state.wdaClient.click(elementId);
    return successResponse(id, { action: "tap", ref, success: true });
  } catch (err) {
    if (err instanceof RefResolutionError) {
      return errorResponse(id, err.message);
    }
    return errorResponse(
      id,
      `Failed to tap ${ref}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleType = async (
  id: string,
  ref: string,
  text: string
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const elementId = await resolveRef(
      ref,
      state.refStore,
      state.wdaClient.findElement.bind(state.wdaClient)
    );
    await state.wdaClient.type(elementId, text);
    return successResponse(id, { action: "type", ref, text, success: true });
  } catch (err) {
    if (err instanceof RefResolutionError) {
      return errorResponse(id, err.message);
    }
    return errorResponse(
      id,
      `Failed to type into ${ref}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleClear = async (id: string, ref: string): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const elementId = await resolveRef(
      ref,
      state.refStore,
      state.wdaClient.findElement.bind(state.wdaClient)
    );
    await state.wdaClient.clear(elementId);
    return successResponse(id, { action: "clear", ref, success: true });
  } catch (err) {
    if (err instanceof RefResolutionError) {
      return errorResponse(id, err.message);
    }
    return errorResponse(
      id,
      `Failed to clear ${ref}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleSwipe = async (
  id: string,
  ref: string,
  direction: "up" | "down" | "left" | "right"
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const elementId = await resolveRef(
      ref,
      state.refStore,
      state.wdaClient.findElement.bind(state.wdaClient)
    );
    await state.wdaClient.swipe(elementId, direction);
    return successResponse(id, { action: "swipe", ref, direction, success: true });
  } catch (err) {
    if (err instanceof RefResolutionError) {
      return errorResponse(id, err.message);
    }
    return errorResponse(
      id,
      `Failed to swipe ${ref}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleWait = async (
  id: string,
  ref: string,
  timeout: number = 10000
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  // Get ref info from store
  const entry = state.refStore.get(ref);
  if (!entry) {
    return errorResponse(
      id,
      `Unknown ref: ${ref}. Run 'snapshot' first to get element refs.`
    );
  }

  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeout) {
    try {
      const elementId = await resolveRef(
        ref,
        state.refStore,
        state.wdaClient.findElement.bind(state.wdaClient)
      );
      if (elementId) {
        return successResponse(id, {
          action: "wait",
          ref,
          found: true,
          elapsed: Date.now() - startTime,
        });
      }
    } catch {
      // Element not found yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return errorResponse(
    id,
    `Timeout waiting for ${ref} after ${timeout}ms. Element not found.`
  );
};

const handleAlertAccept = async (id: string): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const alertText = await state.wdaClient.getAlertText();
    if (!alertText) {
      return errorResponse(id, "No alert is currently displayed.");
    }
    await state.wdaClient.acceptAlert();
    return successResponse(id, { action: "alert-accept", alertText, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to accept alert: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleAlertDismiss = async (id: string): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const alertText = await state.wdaClient.getAlertText();
    if (!alertText) {
      return errorResponse(id, "No alert is currently displayed.");
    }
    await state.wdaClient.dismissAlert();
    return successResponse(id, { action: "alert-dismiss", alertText, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to dismiss alert: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleAlertButton = async (
  id: string,
  button: string
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    const alertText = await state.wdaClient.getAlertText();
    if (!alertText) {
      return errorResponse(id, "No alert is currently displayed.");
    }
    // Find and tap the button by label
    const element = await state.wdaClient.findElement("accessibility id", button);
    if (!element) {
      // Try by label
      const byLabel = await state.wdaClient.findElement(
        "predicate string",
        `label == '${button}'`
      );
      if (!byLabel) {
        return errorResponse(id, `Alert button "${button}" not found.`);
      }
      await state.wdaClient.click(byLabel.ELEMENT);
    } else {
      await state.wdaClient.click(element.ELEMENT);
    }
    return successResponse(id, { action: "alert-button", button, alertText, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to tap alert button: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleLaunch = async (
  id: string,
  bundleId: string
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    await state.wdaClient.launchApp(bundleId);
    return successResponse(id, { action: "launch", bundleId, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to launch ${bundleId}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleTerminate = async (
  id: string,
  bundleId: string
): Promise<Response> => {
  if (!state.wdaClient) {
    return errorResponse(
      id,
      "WDA not running. Run 'agent-ios start-session' first."
    );
  }

  try {
    await state.wdaClient.terminateApp(bundleId);
    return successResponse(id, { action: "terminate", bundleId, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to terminate ${bundleId}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

const handleInstall = async (
  id: string,
  appPath: string
): Promise<Response> => {
  if (!state.simulator) {
    return errorResponse(
      id,
      "No simulator selected. Run 'agent-ios start-session' first."
    );
  }

  try {
    await installApp(state.simulator.udid, appPath);
    return successResponse(id, { action: "install", appPath, success: true });
  } catch (err) {
    return errorResponse(
      id,
      `Failed to install ${appPath}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
};

// Cleanup function
const cleanup = () => {
  const socketPath = getSocketPath();
  const pidPath = getPidPath();

  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }

  if (fs.existsSync(pidPath)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {}
  }
};

// Main
const main = async () => {
  const session = getSessionName();
  const socketPath = getSocketPath(session);
  const pidPath = getPidPath(session);

  // Write PID file
  fs.writeFileSync(pidPath, process.pid.toString());

  // Create and start server
  const server = new SocketServer(socketPath, handleCommand);

  // Handle signals for cleanup
  const handleSignal = async () => {
    // Stop WDA gracefully
    if (state.wdaManager) {
      await state.wdaManager.stop();
    }
    server.stop();
    cleanup();
    process.exit(0);
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
  process.on("SIGHUP", handleSignal);

  try {
    await server.start();
    console.error(
      `agent-ios daemon started (session: ${session}, pid: ${process.pid})`
    );
    console.error(`Listening on: ${socketPath}`);
  } catch (err) {
    console.error("Failed to start daemon:", err);
    cleanup();
    process.exit(1);
  }
};

main();
