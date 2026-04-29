import type { ServerWebSocket } from "bun";
import { chatEventEmitter, loopEventEmitter, provisioningEventEmitter, sshSessionEventEmitter } from "../../core/event-emitter";
import { createLogger } from "../../core/logger";
import { sanitizeProvisioningEvent } from "../../lib/sensitive-data";
import { isStandaloneChat } from "../../types/chat";
import type { ChatEvent, LoopEvent, ProvisioningEvent, SshSessionEvent } from "../../types";
import type { WebSocketData } from "./types";
import { startTerminalBridge } from "./terminal";

const log = createLogger("api:websocket");

/** Maximum number of concurrent WebSocket connections allowed */
export const MAX_CONNECTIONS = 100;

/** Set of active WebSocket connections for tracking and limit enforcement */
export const activeConnections = new Set<ServerWebSocket<WebSocketData>>();

function shouldForwardUnscopedChatEvent(event: ChatEvent): boolean {
  switch (event.type) {
    case "chat.created":
      return isStandaloneChat(event.config);
    case "chat.updated":
      return isStandaloneChat(event.chat);
    case "chat.status":
    case "chat.interrupted":
    case "chat.error":
    case "chat.deleted":
      return event.scope === "workspace";
    default:
      return true;
  }
}

/**
 * Called when a WebSocket connection is opened.
 *
 * Sets up event subscription and sends initial connection confirmation.
 * The confirmation message includes the loopId filter if one was specified.
 */
export function open(ws: ServerWebSocket<WebSocketData>): void {
  const {
    loopId,
    chatId,
    sshSessionId,
    sshServerSessionId,
    provisioningJobId,
    sensitive,
    terminalMode,
    portForwardMode,
    proxyTargetUrl,
    portForwardId,
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
    loopId: loopId ?? "all",
    chatId: chatId ?? "all",
    activeConnections: activeConnections.size,
  });

  // Terminal sockets attach directly to SSH sessions and do not subscribe to app events.
  const terminalSessionId = sshSessionId ?? sshServerSessionId;
  if (terminalMode && terminalSessionId) {
    if (sshServerSessionId) {
      return;
    }

    void startTerminalBridge(ws);
    return;
  }

  if (portForwardMode && proxyTargetUrl) {
    const proxySocket = new WebSocket(proxyTargetUrl);
    proxySocket.binaryType = "arraybuffer";
    ws.data.proxySocket = proxySocket;

    proxySocket.addEventListener("message", (event) => {
      try {
        ws.send(event.data);
      } catch (sendError) {
        log.trace("Failed to send proxied websocket payload", {
          error: String(sendError),
          portForwardId,
        });
      }
    });

    proxySocket.addEventListener("close", (event) => {
      ws.close(event.code || 1000, event.reason || undefined);
    });

    proxySocket.addEventListener("error", () => {
      try {
        ws.close(1011, "Upstream websocket error");
      } catch {
        // Ignore close errors during websocket proxy cleanup.
      }
    });
    return;
  }

  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: "connected",
    loopId: loopId ?? null,
    chatId: chatId ?? null,
    sshSessionId: sshSessionId ?? null,
    sshServerSessionId: sshServerSessionId ?? null,
    provisioningJobId: provisioningJobId ?? null,
  }));

  const hasScopedSubscription = Boolean(
    loopId || chatId || sshSessionId || sshServerSessionId || provisioningJobId,
  );
  const shouldSubscribeToAllRuntimeEvents = !hasScopedSubscription;

  const shouldSubscribeToLoopEvents = shouldSubscribeToAllRuntimeEvents || !!loopId;
  const loopUnsubscribe = shouldSubscribeToLoopEvents
    ? loopEventEmitter.subscribe((event: LoopEvent) => {
        if (loopId && "loopId" in event && event.loopId !== loopId) {
          return;
        }

        try {
          ws.send(JSON.stringify(event));
        } catch (sendError) {
          log.trace("Failed to send event to WebSocket client", { error: String(sendError) });
        }
      })
    : undefined;

  const shouldSubscribeToChatEvents = shouldSubscribeToAllRuntimeEvents || !!chatId;
  const chatUnsubscribe = shouldSubscribeToChatEvents
    ? chatEventEmitter.subscribe((event: ChatEvent) => {
        if (chatId && event.chatId !== chatId) {
          return;
        }
        if (shouldSubscribeToAllRuntimeEvents && !shouldForwardUnscopedChatEvent(event)) {
          return;
        }

        try {
          ws.send(JSON.stringify(event));
        } catch (sendError) {
          log.trace("Failed to send chat event to WebSocket client", { error: String(sendError) });
        }
      })
    : undefined;

  const shouldSubscribeToSshEvents = shouldSubscribeToAllRuntimeEvents || !!sshSessionId || !!sshServerSessionId;
  const sshSessionUnsubscribe = shouldSubscribeToSshEvents
    ? sshSessionEventEmitter.subscribe((event: SshSessionEvent) => {
        const expectedSessionId = sshSessionId ?? sshServerSessionId;
        if (expectedSessionId && event.sshSessionId !== expectedSessionId) {
          return;
        }

        try {
          ws.send(JSON.stringify(event));
        } catch (sendError) {
          log.trace("Failed to send SSH session event to WebSocket client", { error: String(sendError) });
        }
      })
    : undefined;

  const provisioningUnsubscribe = provisioningJobId
    ? provisioningEventEmitter.subscribe((event: ProvisioningEvent) => {
        if (event.provisioningJobId !== provisioningJobId) {
          return;
        }

        try {
          ws.send(JSON.stringify(sensitive ? event : sanitizeProvisioningEvent(event)));
        } catch (sendError) {
          log.trace("Failed to send provisioning event to WebSocket client", {
            error: String(sendError),
          });
        }
      })
    : undefined;

  ws.data.unsubscribers = [
    ...(loopUnsubscribe ? [loopUnsubscribe] : []),
    ...(chatUnsubscribe ? [chatUnsubscribe] : []),
    ...(sshSessionUnsubscribe ? [sshSessionUnsubscribe] : []),
    ...(provisioningUnsubscribe ? [provisioningUnsubscribe] : []),
  ];
}

/**
 * Called when the WebSocket connection is closed.
 *
 * Cleans up the event subscription to prevent memory leaks.
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

  if (ws.data.proxySocket) {
    ws.data.proxySocket.close();
    ws.data.proxySocket = undefined;
  }

  if (ws.data.unsubscribers) {
    for (const unsubscribe of ws.data.unsubscribers) {
      unsubscribe();
    }
    ws.data.unsubscribers = undefined;
  }
}

/**
 * Called when an error occurs on the WebSocket connection.
 *
 * Logs the error and cleans up the event subscription.
 */
export function error(ws: ServerWebSocket<WebSocketData>, err: Error): void {
  log.error("WebSocket error", {
    error: String(err),
    loopId: ws.data.loopId,
    chatId: ws.data.chatId,
    sshSessionId: ws.data.sshSessionId,
    sshServerSessionId: ws.data.sshServerSessionId,
    provisioningJobId: ws.data.provisioningJobId,
  });
  // Remove from active connections
  activeConnections.delete(ws);
  if (ws.data.terminalBridge) {
    void ws.data.terminalBridge.dispose();
    ws.data.terminalBridge = undefined;
  }
  if (ws.data.proxySocket) {
    ws.data.proxySocket.close();
    ws.data.proxySocket = undefined;
  }
  if (ws.data.unsubscribers) {
    for (const unsubscribe of ws.data.unsubscribers) {
      unsubscribe();
    }
    ws.data.unsubscribers = undefined;
  }
}
