import { z } from "zod";

// Session name from environment or default
export const getSessionName = (): string => {
  return process.env.IOS_AGENT_SESSION || "default";
};

// Socket path for daemon communication
export const getSocketPath = (session: string = getSessionName()): string => {
  return `/tmp/agent-ios-${session}.sock`;
};

// PID file path for daemon detection
export const getPidPath = (session: string = getSessionName()): string => {
  return `/tmp/agent-ios-${session}.pid`;
};

// Command schemas
const StartSessionCommand = z.object({
  id: z.string(),
  action: z.literal("start-session"),
  sim: z.string().optional(),
});

const StopSessionCommand = z.object({
  id: z.string(),
  action: z.literal("stop-session"),
});

const StatusCommand = z.object({
  id: z.string(),
  action: z.literal("status"),
});

const ListSimsCommand = z.object({
  id: z.string(),
  action: z.literal("list-sims"),
});

const SnapshotCommand = z.object({
  id: z.string(),
  action: z.literal("snapshot"),
});

const ScreenshotCommand = z.object({
  id: z.string(),
  action: z.literal("screenshot"),
  out: z.string().optional(), // Output file path
});

const TapCommand = z.object({
  id: z.string(),
  action: z.literal("tap"),
  ref: z.string(),
});

const TypeCommand = z.object({
  id: z.string(),
  action: z.literal("type"),
  ref: z.string(),
  text: z.string(),
});

const ClearCommand = z.object({
  id: z.string(),
  action: z.literal("clear"),
  ref: z.string(),
});

const SwipeCommand = z.object({
  id: z.string(),
  action: z.literal("swipe"),
  ref: z.string(),
  direction: z.enum(["up", "down", "left", "right"]),
});

const WaitCommand = z.object({
  id: z.string(),
  action: z.literal("wait"),
  ref: z.string(),
  timeout: z.number().optional(), // milliseconds, default 10000
});

const AlertAcceptCommand = z.object({
  id: z.string(),
  action: z.literal("alert-accept"),
});

const AlertDismissCommand = z.object({
  id: z.string(),
  action: z.literal("alert-dismiss"),
});

const AlertButtonCommand = z.object({
  id: z.string(),
  action: z.literal("alert-button"),
  button: z.string(),
});

const LaunchCommand = z.object({
  id: z.string(),
  action: z.literal("launch"),
  bundleId: z.string(),
});

const TerminateCommand = z.object({
  id: z.string(),
  action: z.literal("terminate"),
  bundleId: z.string(),
});

const InstallCommand = z.object({
  id: z.string(),
  action: z.literal("install"),
  appPath: z.string(),
});

// Union of all commands
export const CommandSchema = z.discriminatedUnion("action", [
  StartSessionCommand,
  StopSessionCommand,
  StatusCommand,
  ListSimsCommand,
  SnapshotCommand,
  ScreenshotCommand,
  TapCommand,
  TypeCommand,
  ClearCommand,
  SwipeCommand,
  WaitCommand,
  AlertAcceptCommand,
  AlertDismissCommand,
  AlertButtonCommand,
  LaunchCommand,
  TerminateCommand,
  InstallCommand,
]);

export type Command = z.infer<typeof CommandSchema>;

// Response schemas
const SuccessResponse = z.object({
  id: z.string(),
  success: z.literal(true),
  data: z.unknown(),
});

const ErrorResponse = z.object({
  id: z.string(),
  success: z.literal(false),
  error: z.string(),
});

export const ResponseSchema = z.union([SuccessResponse, ErrorResponse]);

export type Response = z.infer<typeof ResponseSchema>;

// Helper to create responses
export const successResponse = (id: string, data: unknown): Response => ({
  id,
  success: true,
  data,
});

export const errorResponse = (id: string, error: string): Response => ({
  id,
  success: false,
  error,
});

// Parse a command from JSON string
export const parseCommand = (json: string): Command | null => {
  try {
    const parsed = JSON.parse(json);
    const result = CommandSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
};

// Generate unique command ID
export const generateId = (): string => {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};
