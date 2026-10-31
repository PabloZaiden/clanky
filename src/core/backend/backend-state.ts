/**
 * Connection state tracking and readiness types for the backend manager.
 * Includes server event types, connection state interfaces, and utilities
 * for comparing runtime settings.
 */

import type { Backend } from "../../backends/types";
import type { ExecutionHostBinding } from "@/shared/execution-host";
import type { TaskEvent } from "@/shared/events";
import { areServerSettingsEqual, type ConnectionStatus, type RuntimeServerSettings } from "@/shared/settings";

export { type ConnectionStatus };

/**
 * Bounds backend initialization and remote connection operations.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 75_000;

/**
 * Connection state for a workspace.
 * Used for workspace-level operations (directory validation, model listing, name generation).
 */
export interface WorkspaceConnectionState {
  userId: string;
  backend: Backend;
  settings: RuntimeServerSettings;
  connectionError: string | null;
  localNodeId?: string | null;
  executionHostBinding?: ExecutionHostBinding | null;
  connection?: {
    directory: string;
    controller: AbortController;
    pending?: Promise<void>;
  };
}

/**
 * Connection state for a task.
 * Each task gets its own dedicated backend connection.
 * The actual directory binding happens later when TaskEngine calls backend.connect()
 * in setupSession() with the worktree directory.
 */
export interface TaskConnectionState {
  userId: string;
  backend: Backend;
  workspaceId: string;
  settings: RuntimeServerSettings;
  executionHostBinding: ExecutionHostBinding;
}

export function areRuntimeServerSettingsEqual(left: RuntimeServerSettings, right: RuntimeServerSettings): boolean {
  return areServerSettingsEqual(left, right)
    && left.agent.transport === right.agent.transport;
}

/**
 * Server status events.
 * These are emitted via the global event emitter.
 */
export interface ServerConnectedEvent {
  type: "server.connected";
  workspaceId?: string;
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

export function isServerEvent(event: { type?: unknown }): event is ServerEvent {
  return typeof event.type === "string" && event.type.startsWith("server.");
}

/**
 * Combined event type for the event emitter.
 */
export type AppEvent = TaskEvent | ServerEvent;
