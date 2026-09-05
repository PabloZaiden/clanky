/**
 * Execution-host terminal session domain types.
 *
 * Sessions may belong to a workspace or directly to a canonical execution
 * host. Both forms can use a persistent dtach-backed shell or a direct shell.
 */

import type { ExecutionHostBinding } from "./execution-host";

/**
 * Terminal connection mode — how the terminal shell is managed.
 */
export type TerminalConnectionMode = "dtach" | "direct";

export const DEFAULT_TERMINAL_CONNECTION_MODE: TerminalConnectionMode = "dtach";
export const DEFAULT_TERMINAL_USE_TMUX = false;

export function normalizeTerminalConnectionMode(value: unknown): TerminalConnectionMode {
  return value === "direct" ? "direct" : "dtach";
}

export function normalizeTerminalUseTmux(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return DEFAULT_TERMINAL_USE_TMUX;
}

/**
 * Runtime status for a workspace terminal session.
 */
export type TerminalSessionStatus =
  | "ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

/** Persistent terminal session configuration. */
export interface TerminalSessionConfig {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Workspace that owns this session, absent for direct host sessions */
  workspaceId?: string;
  /** Optional task associated with this session */
  taskId?: string;
  /** Working directory for the terminal shell */
  directory: string;
  /** How this session connects (dtach or direct) */
  connectionMode: TerminalConnectionMode;
  /** Whether the shell bootstrap should try to open tmux first */
  useTmux: boolean;
  /** Remote identifier used for persistent session sockets and direct-shell tracking */
  remoteSessionName: string;
  /** Workspace target revision captured at creation, absent for direct sessions. */
  workspaceExecutionTargetRevision?: number;
  /** Canonical execution host snapshot. */
  executionHostBinding: ExecutionHostBinding;
  /** ISO 8601 timestamp of when the session was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last configuration update */
  updatedAt: string;
  /** Whether the item should be visually hidden when private items are hidden */
  isPrivate?: boolean;
}

/**
 * Persistent workspace terminal session runtime state.
 */
export interface TerminalSessionState {
  /** Current session status */
  status: TerminalSessionStatus;
  /** Last time a client successfully connected */
  lastConnectedAt?: string;
  /** Last recorded error message */
  error?: string;
  /**
   * Runtime override when the configured persistent backend is unavailable
   * and the current connection fell back to a different mode.
   */
  runtimeConnectionMode?: TerminalConnectionMode;
  /** User-visible notice about non-fatal session behavior changes */
  notice?: string;
}

/**
 * Combined workspace terminal session object returned by the API.
 */
export interface TerminalSession {
  config: TerminalSessionConfig;
  state: TerminalSessionState;
}
