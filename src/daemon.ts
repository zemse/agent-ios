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
  type Simulator,
} from "./simctl.js";
import { WDAManager } from "./wda.js";
import { WDAClient } from "./wda-client.js";
import { parseWDASource, createRefStore, type RefStore } from "./snapshot.js";

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
          `Simulator not found: ${simName}. Run 'ios-agent list-sims' to see available simulators.`
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
      console.error("WDA started, waiting for it to be ready...");

      // Wait for WDA to be ready
      await state.wdaManager.waitForReady(60000);
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
      "WDA not running. Run 'ios-agent start-session' first."
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
      "WDA not running. Run 'ios-agent start-session' first."
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
      `ios-agent daemon started (session: ${session}, pid: ${process.pid})`
    );
    console.error(`Listening on: ${socketPath}`);
  } catch (err) {
    console.error("Failed to start daemon:", err);
    cleanup();
    process.exit(1);
  }
};

main();
