/**
 * WebSocket handlers for Ralph Loops Management System.
 *
 * Supports three websocket surfaces:
 * - WS /api/ws for loop events and SSH session lifecycle events
 * - WS /api/ssh-terminal for interactive SSH terminal streams
 * - forwarded-port proxy websocket upgrades under /loop/:loopId/port/:forwardId
 *
 * Features:
 * - Real-time loop and SSH session event streaming
 * - Optional loop or SSH session filtering via query parameters
 * - Ping/pong keep-alive support
 * - Automatic cleanup on disconnect
 *
 * Event Types Streamed:
 * - chat.created, chat.updated, chat.status, chat.interrupted, chat.error, chat.deleted
 * - loop.created, loop.started, loop.completed, loop.ssh_handoff, loop.stopped, loop.error
 * - loop.iteration.start, loop.iteration.end
 * - loop.message, loop.tool_call, loop.progress, loop.log
 * - loop.git.commit, loop.deleted, loop.merged, loop.accepted, loop.pushed, loop.discarded
 * - loop.plan.ready, loop.plan.feedback, loop.plan.accepted, loop.plan.discarded
 * - loop.pending.updated, loop.automatic_pr_flow.updated
 * - ssh_session.created, ssh_session.updated, ssh_session.deleted, ssh_session.status
 * - ssh_session.port_forward.created, ssh_session.port_forward.updated,
 *   ssh_session.port_forward.deleted, ssh_session.port_forward.status
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
