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
const sendCommand = async (command: Command, timeout?: number): Promise<void> => {
  const client = new SocketClient(getSocketPath());
  const response = await client.sendCommand(command, timeout);
  output(response);

  if (!response.success) {
    process.exit(1);
  }
};

// Parse CLI arguments
const parseArgs = (args: string[]): { command: string; positional: string[]; options: Record<string, string> } => {
  const command = args[0] || "help";
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      options[key] = value;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
};

// Print help
const printHelp = () => {
  console.log(`
ios-agent - LLM-friendly iOS automation CLI

Usage: ios-agent <command> [options]

Session Commands:
  start-session [--sim <name>]  Start daemon, boot simulator, and start WDA
  stop-session                  Stop WDA and daemon
  status                        Check daemon, simulator, and WDA status
  list-sims                     List available simulators

App Commands:
  install <app-path>            Install .app bundle on simulator
  launch <bundle-id>            Launch app by bundle ID
  terminate <bundle-id>         Terminate app by bundle ID

Automation Commands:
  snapshot                      Get accessibility tree as JSON
  screenshot [--out <file>]     Take screenshot (PNG)
  tap <ref>                     Tap element by ref (e.g., @e5)
  type <ref> <text>             Type text into element
  clear <ref>                   Clear text field
  swipe <ref> <direction>       Swipe on element (up/down/left/right)
  wait <ref> [--timeout <ms>]   Wait for element to appear (default: 10s)

Alert Commands:
  alert-accept                  Accept/confirm the current alert
  alert-dismiss                 Dismiss/cancel the current alert
  alert-button <text>           Tap a specific alert button by label

Options:
  --sim <name>      Simulator name (e.g., "iPhone 15")
  --out <file>      Output file path for screenshot
  --timeout <ms>    Timeout in milliseconds (for wait command)
  --help            Show this help message

Environment Variables:
  WDA_PATH        Path to WebDriverAgent (default: ~/WebDriverAgent)
  WDA_PORT        WDA HTTP port (default: 8100)

Examples:
  ios-agent list-sims
  ios-agent start-session --sim "iPhone 15"
  ios-agent install ./MyApp.app
  ios-agent launch com.apple.mobilesafari
  ios-agent snapshot
  ios-agent tap @e5
  ios-agent type @e10 "Hello World"
  ios-agent wait @e5 --timeout 5000
  ios-agent swipe @e1 down
  ios-agent alert-accept
  ios-agent screenshot --out screen.png
  ios-agent terminate com.apple.mobilesafari
  ios-agent stop-session
`);
};

// Main
const main = async () => {
  const args = process.argv.slice(2);
  const { command, positional, options } = parseArgs(args);

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
        // Use longer timeout (3 min) since WDA build can take a while
        if (!isDaemonRunning()) {
          await startDaemon();
        }
        console.error("Starting session (WDA build may take a minute)...");
        console.error("Watch build progress: tail -f /tmp/ios-agent-wda.log");
        await sendCommand(
          {
            id: generateId(),
            action: "start-session",
            sim: options.sim,
          },
          180000 // 3 minutes for WDA startup
        );
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

      case "snapshot": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "snapshot",
        });
        break;
      }

      case "screenshot": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "screenshot",
          out: options.out,
        });
        break;
      }

      case "tap": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const tapRef = positional[0];
        if (!tapRef) {
          fail("Missing ref argument. Usage: ios-agent tap <ref>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "tap",
          ref: tapRef,
        });
        break;
      }

      case "type": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const typeRef = positional[0];
        const typeText = positional[1];
        if (!typeRef || typeText === undefined) {
          fail("Missing arguments. Usage: ios-agent type <ref> <text>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "type",
          ref: typeRef,
          text: typeText,
        });
        break;
      }

      case "clear": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const clearRef = positional[0];
        if (!clearRef) {
          fail("Missing ref argument. Usage: ios-agent clear <ref>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "clear",
          ref: clearRef,
        });
        break;
      }

      case "swipe": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const swipeRef = positional[0];
        const swipeDir = positional[1] as "up" | "down" | "left" | "right";
        if (!swipeRef || !swipeDir) {
          fail("Missing arguments. Usage: ios-agent swipe <ref> <direction>");
          return;
        }
        if (!["up", "down", "left", "right"].includes(swipeDir)) {
          fail("Invalid direction. Use: up, down, left, right");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "swipe",
          ref: swipeRef,
          direction: swipeDir,
        });
        break;
      }

      case "wait": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const waitRef = positional[0];
        if (!waitRef) {
          fail("Missing ref argument. Usage: ios-agent wait <ref> [--timeout <ms>]");
          return;
        }
        const timeout = options.timeout ? parseInt(options.timeout, 10) : undefined;
        await sendCommand({
          id: generateId(),
          action: "wait",
          ref: waitRef,
          timeout,
        });
        break;
      }

      case "alert-accept": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "alert-accept",
        });
        break;
      }

      case "alert-dismiss": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "alert-dismiss",
        });
        break;
      }

      case "alert-button": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const buttonText = positional[0];
        if (!buttonText) {
          fail("Missing button argument. Usage: ios-agent alert-button <text>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "alert-button",
          button: buttonText,
        });
        break;
      }

      case "launch": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const launchBundleId = positional[0];
        if (!launchBundleId) {
          fail("Missing bundle ID. Usage: ios-agent launch <bundle-id>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "launch",
          bundleId: launchBundleId,
        });
        break;
      }

      case "terminate": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const terminateBundleId = positional[0];
        if (!terminateBundleId) {
          fail("Missing bundle ID. Usage: ios-agent terminate <bundle-id>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "terminate",
          bundleId: terminateBundleId,
        });
        break;
      }

      case "install": {
        if (!isDaemonRunning()) {
          fail("Daemon not running. Run 'ios-agent start-session' first.");
          return;
        }
        const appPath = positional[0];
        if (!appPath) {
          fail("Missing app path. Usage: ios-agent install <app-path>");
          return;
        }
        await sendCommand({
          id: generateId(),
          action: "install",
          appPath,
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
