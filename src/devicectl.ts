import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Device {
  identifier: string;
  udid: string; // hardware UDID for xcodebuild (different from CoreDevice identifier)
  name: string;
  model: string;
  osVersion: string;
  connectionState: string;
  transportType: string;
}

interface DevicectlOutput {
  result: {
    devices: Array<{
      identifier: string;
      connectionProperties: {
        transportType: string;
        tunnelState: string;
      };
      deviceProperties: {
        name: string;
        osVersionNumber: string;
      };
      hardwareProperties: {
        marketingName: string;
        platform: string;
        udid: string;
      };
    }>;
  };
}

// List connected physical iOS devices
export const listDevices = (): Device[] => {
  const tmpFile = path.join(
    os.tmpdir(),
    `agent-ios-devicectl-${Date.now()}.json`,
  );

  try {
    execSync(
      `xcrun devicectl list devices --json-output "${tmpFile}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const raw = fs.readFileSync(tmpFile, "utf-8");
    const data: DevicectlOutput = JSON.parse(raw);

    return data.result.devices
      .filter((d) => d.hardwareProperties.platform === "iOS")
      .map((d) => ({
        identifier: d.identifier,
        udid: d.hardwareProperties.udid,
        name: d.deviceProperties.name,
        model: d.hardwareProperties.marketingName,
        osVersion: d.deviceProperties.osVersionNumber,
        connectionState: d.connectionProperties.tunnelState,
        transportType: d.connectionProperties.transportType,
      }));
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
};

// Find a device by name or identifier
export const findDevice = (nameOrId: string): Device | null => {
  const devices = listDevices();
  const lower = nameOrId.toLowerCase();

  // Exact identifier match
  const byId = devices.find((d) => d.identifier === nameOrId);
  if (byId) return byId;

  // Exact name match (case-insensitive)
  const exactName = devices.find((d) => d.name.toLowerCase() === lower);
  if (exactName) return exactName;

  // Partial name match
  const partial = devices.find((d) => d.name.toLowerCase().includes(lower));
  return partial || null;
};

// Install app on a physical device
export const installAppOnDevice = async (
  identifier: string,
  appPath: string,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn("xcrun", [
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      identifier,
      appPath,
    ]);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to install app on device: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
};
