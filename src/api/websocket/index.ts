/**
 * WebSocket handlers for Clanky Tasks Management System.
 *
 * Supports raw websocket surfaces:
 * - WS /api/ssh-terminal for interactive SSH terminal streams
 * - WS /api/vnc for raw VNC traffic
 * - WS /api/previews/bridge for live-preview forwarding
 *
 * Features:
 * - Raw terminal, VNC, and preview bridge transport
 * - Ping/pong keep-alive support
 * - Automatic cleanup on disconnect
 *
 * Normal application state events are delivered through framework realtime.
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
 * These handlers manage raw WebSocket transport lifecycles.
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
