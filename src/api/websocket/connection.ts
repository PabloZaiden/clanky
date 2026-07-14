import type { ServerWebSocket } from "bun";
import { createLogger } from "../../core/logger";
import type { WebSocketData } from "./types";
import { startTerminalBridge } from "./terminal";
import { vncSessionManager } from "../../core/vnc-session-manager";
import { runWithCurrentUser } from "../../core/user-context";
import { previewSessionManager } from "../../core/preview-session-manager";

const log = createLogger("api:websocket");

/** Maximum number of concurrent WebSocket connections allowed */
export const MAX_CONNECTIONS = 100;
export const PREVIEW_BRIDGE_KEEPALIVE_INTERVAL_MS = 30000;

/** Set of active WebSocket connections for tracking and limit enforcement */
export const activeConnections = new Set<ServerWebSocket<WebSocketData>>();

export function startPreviewBridgeKeepalive(
  ws: ServerWebSocket<WebSocketData>,
  intervalMs = PREVIEW_BRIDGE_KEEPALIVE_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "bridge.ping" }));
    } catch (sendError) {
      log.trace("Failed to send preview bridge keepalive", { error: String(sendError) });
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function clearPreviewBridgeKeepalive(ws: ServerWebSocket<WebSocketData>): void {
  if (!ws.data.previewBridgeKeepalive) {
    return;
  }
  clearInterval(ws.data.previewBridgeKeepalive);
  ws.data.previewBridgeKeepalive = undefined;
}

/**
 * Called when a WebSocket connection is opened.
 *
 * Attaches the socket to its raw transport and starts any required bridge.
 */
export function open(ws: ServerWebSocket<WebSocketData>): void {
  const {
    sshSessionId,
    sshServerSessionId,
    terminalMode,
    vncMode,
    vncSessionId,
    previewBridgeMode,
  } = ws.data;

  // Enforce connection limit — close oldest connection if at capacity
  if (activeConnections.size >= MAX_CONNECTIONS) {
    const oldest = activeConnections.values().next().value;
    if (oldest) {
      log.warn("WebSocket connection limit reached, closing oldest connection", {
        maxConnections: MAX_CONNECTIONS,
        activeConnections: activeConnections.size,
      });
      oldest.close(1008, "Connection limit exceeded");
    }
  }

  // Track this connection
  activeConnections.add(ws);
  log.info("WebSocket connection opened", {
    terminalMode: terminalMode ?? false,
    vncMode: vncMode ?? false,
    previewBridgeMode: previewBridgeMode ?? false,
    sshSessionId: sshSessionId ?? "none",
    sshServerSessionId: sshServerSessionId ?? "none",
    vncSessionId: vncSessionId ?? "none",
    activeConnections: activeConnections.size,
  });

  // Preview bridge sockets use the raw transport directly and do not subscribe to app events.
  if (previewBridgeMode) {
    ws.send(JSON.stringify({ type: "connected" }));
    ws.data.previewBridgeKeepalive = startPreviewBridgeKeepalive(ws);
    return;
  }

  // Terminal sockets attach directly to SSH sessions and do not subscribe to app events.
  const terminalSessionId = sshSessionId ?? sshServerSessionId;
  if (terminalMode && terminalSessionId) {
    if (sshServerSessionId) {
      return;
    }

    void startTerminalBridge(ws);
    return;
  }

  if (vncMode && vncSessionId) {
    if (!ws.data.user) {
      ws.close(1008, "Authenticated user context is required for VNC connections");
      return;
    }

    void runWithCurrentUser(ws.data.user, () => vncSessionManager.openTcpSocket(vncSessionId)).then(({ socket }) => {
      ws.data.vncSocket = socket;
      const pendingMessages = ws.data.pendingVncMessages ?? [];
      ws.data.pendingVncMessages = undefined;
      for (const pendingMessage of pendingMessages) {
        socket.write(pendingMessage);
      }
      socket.on("data", (chunk) => {
        try {
          if (typeof chunk === "string") {
            ws.send(chunk);
            return;
          }
          ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch (sendError) {
          log.trace("Failed to send VNC socket payload", { vncSessionId, error: String(sendError) });
        }
      });
      socket.once("close", () => ws.close(1000));
      socket.once("error", (socketError) => {
        log.warn("VNC TCP bridge error", { vncSessionId, error: String(socketError) });
        ws.close(1011, "VNC TCP bridge error");
      });
    }).catch((bridgeError: Error) => {
      log.warn("Failed to open VNC TCP bridge", { vncSessionId, error: String(bridgeError) });
      ws.close(1011, "VNC session unavailable");
    });
    return;
  }
}

/**
 * Called when the WebSocket connection is closed.
 *
 * Cleans up transport resources to prevent leaks.
 */
export function close(ws: ServerWebSocket<WebSocketData>): void {
  // Remove from active connections
  activeConnections.delete(ws);
  log.info("WebSocket connection closed", {
    activeConnections: activeConnections.size,
  });

  if (ws.data.terminalBridge) {
    void ws.data.terminalBridge.dispose();
    ws.data.terminalBridge = undefined;
  }

  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
  }

  if (ws.data.previewBridgeSessionId && ws.data.user) {
    void previewSessionManager.closeBridgeSession(ws, "Preview bridge disconnected");
  }
  clearPreviewBridgeKeepalive(ws);
}

/**
 * Called when an error occurs on the WebSocket connection.
 *
 * Logs the error and cleans up transport resources.
 */
export function error(ws: ServerWebSocket<WebSocketData>, err: Error): void {
  log.error("WebSocket error", {
    error: String(err),
    sshSessionId: ws.data.sshSessionId,
    sshServerSessionId: ws.data.sshServerSessionId,
    vncSessionId: ws.data.vncSessionId,
    previewBridgeSessionId: ws.data.previewBridgeSessionId,
  });
  // Remove from active connections
  activeConnections.delete(ws);
  if (ws.data.terminalBridge) {
    void ws.data.terminalBridge.dispose();
    ws.data.terminalBridge = undefined;
  }
  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
  }
  if (ws.data.previewBridgeSessionId && ws.data.user) {
    void previewSessionManager.closeBridgeSession(ws, "Preview bridge error");
  }
  clearPreviewBridgeKeepalive(ws);
}
