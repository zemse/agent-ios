import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  type Command,
  getSocketPath,
  getPidPath,
  generateId,
} from "./protocol.js";
import { SocketClient } from "./socket-client.js";
import { listSimulators } from "./simctl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Print JSON response to stdout
const output = (data: unknown) => {
  console.log(JSON.stringify(data, null, 2));
};

// Print error and exit
const fail = (error: string) => {
  output({ success: false, error });
  process.exit(1);
};

// Check if daemon is running
const isDaemonRunning = (): boolean => {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    // Check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try {
      fs.unlinkSync(pidPath);
    } catch {}
    return false;
  }
};

// Start daemon in background
const startDaemon = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const daemonPath = path.join(__dirname, "daemon.js");

    // Spawn daemon as detached process
    const child = spawn("node", [daemonPath], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });

    child.unref();

    // Wait a bit for daemon to start
    setTimeout(() => {
      if (isDaemonRunning()) {
        resolve();
      } else {
        reject(new Error("Daemon failed to start"));
      }
    }, 500);
  });
};

// Ensure daemon is running, start if needed
const ensureDaemon = async (): Promise<void> => {
  if (!isDaemonRunning()) {
    await startDaemon();
  }
};

// Send command to daemon
const sendCommand = async (command: Command): Promise<void> => {
  const client = new SocketClient(getSocketPath());
  const response = await client.sendCommand(command);
  output(response);

  if (!response.success) {
    process.exit(1);
  }
};

// Parse CLI arguments
const parseArgs = (args: string[]): { command: string; options: Record<string, string> } => {
  const command = args[0] || "help";
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      options[key] = value;
    } else if (!options._positional) {
      options._positional = arg;
    }
  }

  return { command, options };
};

// Print help
const printHelp = () => {
  console.log(`
ios-agent - LLM-friendly iOS automation CLI

Usage: ios-agent <command> [options]

Commands:
  start-session [--sim <name>]  Start daemon and optionally boot simulator
  stop-session                  Stop daemon
  status                        Check daemon and simulator status
  list-sims                     List available simulators

Options:
  --sim <name>    Simulator name (e.g., "iPhone 15")
  --help          Show this help message

Examples:
  ios-agent list-sims
  ios-agent start-session --sim "iPhone 15"
  ios-agent status
  ios-agent stop-session
`);
};

// Main
const main = async () => {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (command === "help" || options.help) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "list-sims": {
        // list-sims can work without daemon
        const simulators = listSimulators();
        output({
          success: true,
          data: {
            simulators: simulators.map((s) => ({
              name: s.name,
              udid: s.udid,
              state: s.state,
              runtime: s.runtime,
            })),
          },
        });
        break;
      }

      case "start-session": {
        // Start daemon if not running, then send command
        if (!isDaemonRunning()) {
          await startDaemon();
        }
        await sendCommand({
          id: generateId(),
          action: "start-session",
          sim: options.sim,
        });
        break;
      }

      case "stop-session": {
        if (!isDaemonRunning()) {
          output({ success: true, data: { message: "Daemon not running" } });
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "stop-session",
        });
        break;
      }

      case "status": {
        if (!isDaemonRunning()) {
          output({
            success: true,
            data: {
              running: false,
              message: "Daemon not running",
            },
          });
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "status",
        });
        break;
      }

      default:
        fail(`Unknown command: ${command}. Run 'ios-agent help' for usage.`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : "Unknown error");
  }
};

main();
