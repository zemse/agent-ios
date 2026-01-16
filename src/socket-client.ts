import * as net from "net";
import { type Command, type Response, ResponseSchema } from "./protocol.js";

export class SocketClient {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async sendCommand(command: Command, timeout: number = 30000): Promise<Response> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          reject(new Error("Command timed out"));
        }
      }, timeout);

      socket.on("connect", () => {
        socket.write(JSON.stringify(command) + "\n");
      });

      socket.on("data", (data) => {
        buffer += data.toString();

        // Look for complete response (newline-delimited JSON)
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const json = buffer.slice(0, newlineIndex);
          clearTimeout(timeoutId);
          resolved = true;
          socket.end();

          try {
            const parsed = JSON.parse(json);
            const result = ResponseSchema.safeParse(parsed);
            if (result.success) {
              resolve(result.data);
            } else {
              reject(new Error("Invalid response format from daemon"));
            }
          } catch {
            reject(new Error("Failed to parse daemon response"));
          }
        }
      });

      socket.on("error", (err) => {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("Daemon not running. Start with: ios-agent start-session"));
          } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
            reject(new Error("Daemon not responding. Try: ios-agent stop-session && ios-agent start-session"));
          } else {
            reject(err);
          }
        }
      });

      socket.on("close", () => {
        if (!resolved) {
          clearTimeout(timeoutId);
          resolved = true;
          reject(new Error("Connection closed unexpectedly"));
        }
      });
    });
  }

  // Check if daemon is running by testing socket connection
  async isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);

      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });

      socket.on("error", () => {
        resolve(false);
      });
    });
  }
}
