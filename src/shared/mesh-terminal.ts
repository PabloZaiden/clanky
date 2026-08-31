/**
 * Bounded Mesh protocol for interactive terminal streams.
 */

export const MESH_TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MESH_TERMINAL_CAPABILITY = "terminal-v1" as const;
export const MESH_TERMINAL_SESSION_TTL_MS = 30 * 60 * 1000;
export const MESH_TERMINAL_SESSION_REQUEST_TTL_MS = MESH_TERMINAL_SESSION_TTL_MS - 15_000;
export const MESH_TERMINAL_SESSION_REQUEST_TIMEOUT_MS = 10_000;
export const MESH_TERMINAL_WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;
export const MESH_TERMINAL_LEASE_CHECK_INTERVAL_MS = 15_000;
export const MESH_TERMINAL_MAX_FRAME_BYTES = 512 * 1024;
export const MESH_TERMINAL_MAX_INPUT_BYTES = 64 * 1024;
export const MESH_TERMINAL_MAX_OUTPUT_BYTES = 256 * 1024;
export const MESH_TERMINAL_MAX_CLIPBOARD_BYTES = 64 * 1024;
export const MESH_TERMINAL_MAX_HANDSHAKE_BYTES = 256 * 1024;

export type MeshTerminalClientFrame =
  | { type: "terminal.input"; data: string }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "terminal.close" }
  | { type: "ping" };

export type MeshTerminalServerFrame =
  | {
      type: "terminal.ready";
      runtimeConnectionMode: "dtach" | "direct";
      notice?: string;
    }
  | { type: "terminal.output"; data: string }
  | { type: "terminal.clipboard"; text: string }
  | { type: "terminal.exit"; code: number | null; signal: string | null }
  | { type: "terminal.error"; code?: string; message: string }
  | { type: "pong" };
