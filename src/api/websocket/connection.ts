import type { ServerWebSocket } from "bun";
import { createLogger } from "@pablozaiden/webapp/server";
import type { WebSocketData } from "./types";
import {
  releaseTerminalSocket,
  startTerminalBridge,
} from "./terminal";
import { vncSessionManager } from "../../core/vnc-session-manager";
import { runWithCurrentUser } from "../../core/user-context";
import { previewSessionManager } from "../../core/preview-session-manager";
import { meshAcpGateway } from "../../core/mesh-acp-gateway";
import { meshTerminalGateway } from "../../core/mesh-terminal-gateway";
import { meshTcpTunnelGateway } from "../../core/mesh-tcp-tunnel-gateway";

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
    terminalSessionId,
    terminalMode,
    vncMode,
    vncSessionId,
    previewBridgeMode,
    meshAcpMode,
    meshAcpSessionId,
    meshAcpSessionToken,
    meshTerminalMode,
    meshTerminalSessionId,
    meshTerminalSessionToken,
    meshTcpTunnelMode,
    meshTcpTunnelSessionId,
    meshTcpTunnelSessionToken,
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
    terminalSessionId: terminalSessionId ?? "none",
    vncSessionId: vncSessionId ?? "none",
    activeConnections: activeConnections.size,
  });

  // Preview bridge sockets use the raw transport directly and do not subscribe to app events.
  if (previewBridgeMode) {
    ws.send(JSON.stringify({ type: "connected" }));
    ws.data.previewBridgeKeepalive = startPreviewBridgeKeepalive(ws);
    return;
  }

  if (meshAcpMode && meshAcpSessionId && meshAcpSessionToken) {
    void meshAcpGateway.open(ws, meshAcpSessionId, meshAcpSessionToken).catch((error: Error) => {
      log.warn("Failed to open mesh ACP relay", {
        sessionId: meshAcpSessionId,
        error: String(error),
      });
      let reason = error.message || "Mesh ACP relay unavailable";
      while (Buffer.byteLength(reason, "utf8") > 123) {
        reason = reason.slice(0, -1);
      }
      ws.close(1011, reason);
    });
    return;
  }

  if (meshTerminalMode && meshTerminalSessionId && meshTerminalSessionToken) {
    void meshTerminalGateway.open(
      ws,
      meshTerminalSessionId,
      meshTerminalSessionToken,
    ).catch((error: Error) => {
      log.warn("Failed to open Mesh terminal relay", {
        sessionId: meshTerminalSessionId,
        error: String(error),
      });
      ws.close(1011, "Mesh terminal relay unavailable");
    });
    return;
  }

  if (meshTcpTunnelMode && meshTcpTunnelSessionId && meshTcpTunnelSessionToken) {
    void meshTcpTunnelGateway.open(
      ws,
      meshTcpTunnelSessionId,
      meshTcpTunnelSessionToken,
    ).catch((error: Error) => {
      log.warn("Failed to open Mesh TCP tunnel relay", {
        sessionId: meshTcpTunnelSessionId,
        error: String(error),
      });
      ws.close(1011, "Mesh TCP tunnel relay unavailable");
    });
    return;
  }

  if (terminalMode && terminalSessionId) {
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
  ws.data.terminalAttachment?.release();
  ws.data.terminalAttachment = undefined;
  const terminalSessionId = ws.data.terminalSessionId;
  if (terminalSessionId) {
    releaseTerminalSocket(terminalSessionId, ws);
  }

  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
  }

  if (ws.data.previewBridgeSessionId && ws.data.user) {
    void previewSessionManager.closeBridgeSession(ws, "Preview bridge disconnected");
  }
  if (ws.data.meshAcpMode && ws.data.meshAcpSessionId) {
    void meshAcpGateway.close(ws.data.meshAcpSessionId);
  }
  if (ws.data.meshTerminalMode && ws.data.meshTerminalSessionId) {
    void meshTerminalGateway.close(ws.data.meshTerminalSessionId, false, 1000, "Mesh terminal closed", ws);
  }
  if (ws.data.meshTcpTunnelMode && ws.data.meshTcpTunnelSessionId) {
    void meshTcpTunnelGateway.close(ws.data.meshTcpTunnelSessionId);
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
    terminalSessionId: ws.data.terminalSessionId,
    vncSessionId: ws.data.vncSessionId,
    previewBridgeSessionId: ws.data.previewBridgeSessionId,
  });
  // Remove from active connections
  activeConnections.delete(ws);
  if (ws.data.terminalBridge) {
    void ws.data.terminalBridge.dispose();
    ws.data.terminalBridge = undefined;
  }
  ws.data.terminalAttachment?.release();
  ws.data.terminalAttachment = undefined;
  const terminalSessionId = ws.data.terminalSessionId;
  if (terminalSessionId) {
    releaseTerminalSocket(terminalSessionId, ws);
  }
  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
  }
  if (ws.data.previewBridgeSessionId && ws.data.user) {
    void previewSessionManager.closeBridgeSession(ws, "Preview bridge error");
  }
  if (ws.data.meshAcpMode && ws.data.meshAcpSessionId) {
    void meshAcpGateway.close(ws.data.meshAcpSessionId);
  }
  if (ws.data.meshTerminalMode && ws.data.meshTerminalSessionId) {
    void meshTerminalGateway.close(ws.data.meshTerminalSessionId, false, 1000, "Mesh terminal closed", ws);
  }
  if (ws.data.meshTcpTunnelMode && ws.data.meshTcpTunnelSessionId) {
    void meshTcpTunnelGateway.close(ws.data.meshTcpTunnelSessionId, 1011, "Mesh TCP tunnel failed");
  }
  clearPreviewBridgeKeepalive(ws);
}
