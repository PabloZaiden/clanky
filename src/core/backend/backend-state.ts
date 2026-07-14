/**
 * Connection state tracking and readiness types for the backend manager.
 * Includes server event types, connection state interfaces, and utilities
 * for deriving execution settings and building server URLs.
 */

import type { Backend } from "../../backends/types";
import type { TaskEvent } from "@/shared/events";
import type { ConnectionStatus, ServerSettings } from "@/shared/settings";
import { getSshConnectionTargetFromSettings, type SshConnectionTarget } from "../ssh-connection-target";

export { type ConnectionStatus };

/**
 * Agent transports that require an explicit remote endpoint.
 */
export const REMOTE_AGENT_TRANSPORTS = new Set(["ssh"]);

/**
 * Default timeout (in ms) for remote connection operations (validation, test connections,
 * workspace connections). This bounds network operations to prevent indefinite hangs
 * when the remote server is unreachable.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Connection state for a workspace.
 * Used for workspace-level operations (directory validation, model listing, name generation).
 */
export interface WorkspaceConnectionState {
  backend: Backend;
  settings: ServerSettings;
  connectionError: string | null;
}

/**
 * Connection state for a task.
 * Each task gets its own dedicated backend connection.
 * The actual directory binding happens later when TaskEngine calls backend.connect()
 * in setupSession() with the worktree directory.
 */
export interface TaskConnectionState {
  backend: Backend;
  workspaceId: string;
}

export interface DerivedExecutionSettings {
  provider: "local" | "ssh";
  sshTarget?: SshConnectionTarget;
}

export function deriveExecutionSettings(settings: ServerSettings): DerivedExecutionSettings {
  const sshTarget = getSshConnectionTargetFromSettings(settings);
  if (sshTarget) {
    return {
      provider: "ssh",
      sshTarget,
    };
  }

  return { provider: "local" };
}

/**
 * Build a displayable server URL for agent transports that expose host/port.
 */
export function buildAgentServerUrl(settings: ServerSettings): string | undefined {
  if (!REMOTE_AGENT_TRANSPORTS.has(settings.agent.transport) || settings.agent.transport !== "ssh") {
    return undefined;
  }
  const sshTarget = getSshConnectionTargetFromSettings(settings);
  if (!sshTarget) {
    return undefined;
  }
  return `ssh://${sshTarget.host}:${sshTarget.port}`;
}

/**
 * Server status events.
 * These are emitted via the global event emitter.
 */
export interface ServerConnectedEvent {
  type: "server.connected";
  workspaceId?: string;
  /** Legacy runtime mode field (ACP path currently emits "spawn"). */
  mode: "spawn" | "connect";
  serverUrl?: string;
  timestamp: string;
}

export interface ServerDisconnectedEvent {
  type: "server.disconnected";
  workspaceId?: string;
  timestamp: string;
}

export interface ServerErrorEvent {
  type: "server.error";
  workspaceId?: string;
  error: string;
  timestamp: string;
}

export interface ServerResetEvent {
  type: "server.reset";
  workspaceId?: string;
  timestamp: string;
}

export type ServerEvent =
  | ServerConnectedEvent
  | ServerDisconnectedEvent
  | ServerErrorEvent
  | ServerResetEvent;

/**
 * Combined event type for the event emitter.
 */
export type AppEvent = TaskEvent | ServerEvent;
