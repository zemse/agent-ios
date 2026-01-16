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
  shutdownSimulator,
  openSimulatorApp,
  getBootedSimulator,
  type Simulator,
} from "./simctl.js";

// Session state
interface SessionState {
  simulator: Simulator | null;
  startedAt: Date;
}

const state: SessionState = {
  simulator: null,
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

    default: {
      // This should never happen with proper typing, but handle it anyway
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
      // Find specific simulator
      simulator = findSimulator(simName);
      if (!simulator) {
        return errorResponse(
          id,
          `Simulator not found: ${simName}. Run 'ios-agent list-sims' to see available simulators.`
        );
      }
    } else {
      // Use already booted simulator or pick first available
      simulator = getBootedSimulator();
      if (!simulator) {
        const sims = listSimulators();
        if (sims.length === 0) {
          return errorResponse(
            id,
            "No simulators available. Install Xcode and create a simulator."
          );
        }
        // Pick first iPhone simulator, or just first one
        simulator =
          sims.find((s) => s.name.includes("iPhone")) || sims[0];
      }
    }

    // Boot if needed
    if (simulator.state !== "Booted") {
      await bootSimulator(simulator.udid);
      // Open Simulator.app so user can see it
      await openSimulatorApp();
      // Update state
      simulator = { ...simulator, state: "Booted" };
    }

    state.simulator = simulator;

    return successResponse(id, {
      simulator: {
        name: simulator.name,
        udid: simulator.udid,
        runtime: simulator.runtime,
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
    if (state.simulator) {
      // Optionally shutdown simulator - for now we leave it running
      // await shutdownSimulator(state.simulator.udid);
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
  // Try to get booted simulator, but don't fail if simctl isn't available
  let booted: Simulator | null = null;
  try {
    booted = getBootedSimulator();
  } catch {
    // simctl not available, that's okay for status
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
  const handleSignal = () => {
    server.stop();
    cleanup();
    process.exit(0);
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
  process.on("SIGHUP", handleSignal);

  try {
    await server.start();
    console.error(`ios-agent daemon started (session: ${session}, pid: ${process.pid})`);
    console.error(`Listening on: ${socketPath}`);
  } catch (err) {
    console.error("Failed to start daemon:", err);
    cleanup();
    process.exit(1);
  }
};

main();
