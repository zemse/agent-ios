import * as net from "net";
import * as fs from "fs";
import { type Command, type Response, parseCommand } from "./protocol.js";

export type CommandHandler = (command: Command) => Promise<Response>;

export class SocketServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private handler: CommandHandler;

  constructor(socketPath: string, handler: CommandHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Clean up existing socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions so any user can connect
        fs.chmodSync(this.socketPath, 0o777);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";

    socket.on("data", async (data) => {
      buffer += data.toString();

      // Process complete lines (commands are newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          await this.processCommand(socket, line);
        }
      }
    });

    socket.on("error", (err) => {
      // Client disconnected, ignore
    });
  }

  private async processCommand(
    socket: net.Socket,
    json: string
  ): Promise<void> {
    const command = parseCommand(json);

    if (!command) {
      const errorResponse: Response = {
        id: "unknown",
        success: false,
        error: "Invalid command format",
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
      return;
    }

    try {
      const response = await this.handler(command);
      socket.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const errorResponse: Response = {
        id: command.id,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
      socket.write(JSON.stringify(errorResponse) + "\n");
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }
}
