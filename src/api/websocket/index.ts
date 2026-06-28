/**
 * WebSocket handlers for Clanky Tasks Management System.
 *
 * Supports three websocket surfaces:
 * - WS /api/ws for task events and SSH session lifecycle events
 * - WS /api/ssh-terminal for interactive SSH terminal streams
 *
 * Features:
 * - Real-time task and SSH session event streaming
 * - Optional task or SSH session filtering via query parameters
 * - Ping/pong keep-alive support
 * - Automatic cleanup on disconnect
 *
 * Event Types Streamed:
 * - chat.created, chat.updated, chat.status, chat.interrupted, chat.error, chat.deleted
 * - task.created, task.started, task.completed, task.ssh_handoff, task.stopped, task.error
 * - task.iteration.start, task.iteration.end
 * - task.message, task.tool_call, task.progress, task.log
 * - task.git.commit, task.deleted, task.merged, task.accepted, task.pushed, task.discarded
 * - task.plan.ready, task.plan.feedback, task.plan.accepted, task.plan.discarded
 * - task.pending.updated, task.automatic_pr_flow.updated
 * - ssh_session.created, ssh_session.updated, ssh_session.deleted, ssh_session.status
 * - preview.created, preview.connected, preview.closed, preview.failed
 *
 * @module api/websocket
 */

export type { WebSocketData } from "./types";
export { startTerminalBridge, sendTerminalAuthError } from "./terminal";
export { open, close, error, activeConnections, MAX_CONNECTIONS } from "./connection";
export { createMessageHandler } from "./message-handler";

import { open, close, error } from "./connection";
import { createMessageHandler } from "./message-handler";
import { startTerminalBridge, sendTerminalAuthError } from "./terminal";

/**
 * WebSocket message handlers for Bun.serve().
 * These handlers manage the WebSocket lifecycle and event streaming.
 *
 * `message` is created via a factory that holds a reference to `websocketHandlers`
 * itself so that spying on `websocketHandlers.startTerminalBridge` in tests correctly
 * intercepts calls made from inside the message handler.
 */
export const websocketHandlers = {
  startTerminalBridge,
  sendTerminalAuthError,
  open,
  close,
  error,
} as {
  startTerminalBridge: typeof startTerminalBridge;
  sendTerminalAuthError: typeof sendTerminalAuthError;
  open: typeof open;
  close: typeof close;
  error: typeof error;
  message: ReturnType<typeof createMessageHandler>;
};

// Assign message after the object is created so `websocketHandlers` is the live
// reference passed to the factory — any spy on the object's methods is intercepted.
(websocketHandlers as Record<string, unknown>)["message"] = createMessageHandler(websocketHandlers);
