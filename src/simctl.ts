import { execSync, spawn } from "child_process";

export interface Simulator {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | string;
  runtime: string;
  isAvailable: boolean;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
}

interface SimctlListOutput {
  devices: Record<string, SimctlDevice[]>;
}

// Execute simctl command and return output
const execSimctl = (args: string[]): string => {
  const cmd = ["xcrun", "simctl", ...args].join(" ");
  return execSync(cmd, { encoding: "utf-8" });
};

// Parse runtime string to friendly name
const parseRuntime = (runtime: string): string => {
  // com.apple.CoreSimulator.SimRuntime.iOS-17-2 -> iOS 17.2
  const match = runtime.match(/SimRuntime\.(.+)$/);
  if (match) {
    return match[1].replace(/-/g, ".").replace(/\./g, " ").replace(/ (\d)/, " $1").replace(/ /g, ".");
  }
  return runtime;
};

// List all available simulators
export const listSimulators = (): Simulator[] => {
  const output = execSimctl(["list", "devices", "-j"]);
  const data: SimctlListOutput = JSON.parse(output);

  const simulators: Simulator[] = [];

  for (const [runtime, devices] of Object.entries(data.devices)) {
    for (const device of devices) {
      if (device.isAvailable) {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: parseRuntime(runtime),
          isAvailable: device.isAvailable,
        });
      }
    }
  }

  return simulators;
};

// Find simulator by name (partial match)
export const findSimulator = (name: string): Simulator | null => {
  const simulators = listSimulators();
  const lowerName = name.toLowerCase();

  // Exact match first
  const exact = simulators.find(
    (s) => s.name.toLowerCase() === lowerName
  );
  if (exact) return exact;

  // Partial match
  const partial = simulators.find((s) =>
    s.name.toLowerCase().includes(lowerName)
  );
  return partial || null;
};

// Get currently booted simulator
export const getBootedSimulator = (): Simulator | null => {
  const simulators = listSimulators();
  return simulators.find((s) => s.state === "Booted") || null;
};

// Boot a simulator by UDID
export const bootSimulator = async (udid: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "boot", udid]);

    proc.on("close", (code) => {
      if (code === 0 || code === 149) {
        // 149 = already booted, which is fine
        resolve();
      } else {
        reject(new Error(`Failed to boot simulator: exit code ${code}`));
      }
    });

    proc.on("error", reject);
  });
};

// Shutdown a simulator by UDID
export const shutdownSimulator = async (udid: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "shutdown", udid]);

    proc.on("close", (code) => {
      if (code === 0 || code === 149) {
        // 149 = already shutdown, which is fine
        resolve();
      } else {
        reject(new Error(`Failed to shutdown simulator: exit code ${code}`));
      }
    });

    proc.on("error", reject);
  });
};

// Open Simulator.app (makes simulator visible)
export const openSimulatorApp = async (): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("open", ["-a", "Simulator"]);

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to open Simulator.app: exit code ${code}`));
      }
    });

    proc.on("error", reject);
  });
};

// Install app on simulator
export const installApp = async (
  udid: string,
  appPath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "install", udid, appPath]);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to install app: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
};

// Launch app on simulator
export const launchApp = async (
  udid: string,
  bundleId: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "launch", udid, bundleId]);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to launch app: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
};

// Terminate app on simulator
export const terminateApp = async (
  udid: string,
  bundleId: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", ["simctl", "terminate", udid, bundleId]);

    proc.on("close", (code) => {
      // Terminate can fail if app isn't running, which is fine
      resolve();
    });

    proc.on("error", reject);
  });
};

// Take screenshot
export const takeScreenshot = async (
  udid: string,
  outputPath: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", [
      "simctl",
      "io",
      udid,
      "screenshot",
      outputPath,
    ]);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to take screenshot: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
};
