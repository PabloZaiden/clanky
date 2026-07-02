/**
 * SSH session domain types.
 *
 * SSH sessions represent saved remote terminal connections on an
 * SSH-configured workspace host. Sessions can either attach to a persistent
 * `dtach`-backed shell or open a direct SSH shell for debugging.
 */

export type SshConnectionMode = "dtach" | "direct";

export const DEFAULT_SSH_CONNECTION_MODE: SshConnectionMode = "dtach";
export const DEFAULT_SSH_SESSION_USE_TMUX = false;

export function normalizeSshConnectionMode(value: unknown): SshConnectionMode {
  return value === "direct" ? "direct" : "dtach";
}

export function normalizeSshSessionUseTmux(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return DEFAULT_SSH_SESSION_USE_TMUX;
}

/**
 * Runtime status for an SSH session.
 */
export type SshSessionStatus =
  | "ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

/**
 * Persistent SSH session configuration.
 */
export interface SshSessionBaseConfig {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Human-readable display name */
  name: string;
  /** How this saved session connects to the remote host */
  connectionMode: SshConnectionMode;
  /** Whether the remote shell bootstrap should try to open tmux first */
  useTmux: boolean;
  /** Remote identifier used for persistent session sockets and direct-shell tty tracking */
  remoteSessionName: string;
  /** ISO 8601 timestamp of when the session was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last configuration update */
  updatedAt: string;
}

/**
 * Persistent SSH session configuration for workspace-backed sessions.
 */
export interface SshSessionConfig {
  /** Common SSH session metadata */
  id: SshSessionBaseConfig["id"];
  /** Human-readable display name */
  name: SshSessionBaseConfig["name"];
  /** Workspace that owns this session */
  workspaceId: string;
  /** Optional task associated with this session */
  taskId?: string;
  /** Working directory used when creating the persistent session shell or direct shell */
  directory: string;
  /** How this saved session connects to the remote host */
  connectionMode: SshSessionBaseConfig["connectionMode"];
  /** Whether the remote shell bootstrap should try to open tmux first */
  useTmux: SshSessionBaseConfig["useTmux"];
  /** Remote identifier used for persistent session sockets and direct-shell tty tracking */
  remoteSessionName: SshSessionBaseConfig["remoteSessionName"];
  /** ISO 8601 timestamp of when the session was created */
  createdAt: SshSessionBaseConfig["createdAt"];
  /** ISO 8601 timestamp of the last configuration update */
  updatedAt: SshSessionBaseConfig["updatedAt"];
  /** Whether the item should be visually hidden when private items are hidden in the browser */
  isPrivate?: boolean;
}

/**
 * Persistent SSH session runtime state.
 */
export interface SshSessionState {
  /** Current session status */
  status: SshSessionStatus;
  /** Last time a client successfully connected */
  lastConnectedAt?: string;
  /** Last recorded error message */
  error?: string;
  /**
   * Runtime override used when the configured persistent backend is unavailable
   * and the current connection had to fall back to a different mode.
   */
  runtimeConnectionMode?: SshConnectionMode;
  /** User-visible notice about non-fatal SSH session behavior changes */
  notice?: string;
}

/**
 * Combined SSH session object returned by the API.
 */
export interface SshSession {
  config: SshSessionConfig;
  state: SshSessionState;
}
