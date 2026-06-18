import type { ServerWebSocket } from "bun";
import {
  agentEventEmitter,
  chatEventEmitter,
  taskEventEmitter,
  provisioningEventEmitter,
  sshSessionEventEmitter,
} from "../../core/event-emitter";
import { createLogger } from "../../core/logger";
import { sanitizeProvisioningEvent } from "../../lib/sensitive-data";
import type { AgentEvent, ChatEvent, TaskEvent, ProvisioningEvent, SshSessionEvent } from "../../types";
import type { WebSocketData } from "./types";
import { startTerminalBridge } from "./terminal";
import { vncSessionManager } from "../../core/vnc-session-manager";

const log = createLogger("api:websocket");

/** Maximum number of concurrent WebSocket connections allowed */
export const MAX_CONNECTIONS = 100;

/** Set of active WebSocket connections for tracking and limit enforcement */
export const activeConnections = new Set<ServerWebSocket<WebSocketData>>();

function getChatEventScope(event: ChatEvent): string | undefined {
  if ("scope" in event) {
    return event.scope;
  }
  if (event.type === "chat.created") {
    return event.config.scope;
  }
  if (event.type === "chat.updated") {
    return event.chat.config.scope;
  }
  return undefined;
}

/**
 * Called when a WebSocket connection is opened.
 *
 * Sets up event subscription and sends initial connection confirmation.
 * The confirmation message includes the taskId filter if one was specified.
 */
export function open(ws: ServerWebSocket<WebSocketData>): void {
  const {
    taskId,
    chatId,
    agentId,
    agentRunId,
    sshSessionId,
    sshServerSessionId,
    provisioningJobId,
    sensitive,
    terminalMode,
    portForwardMode,
    proxyTargetUrl,
    portForwardId,
    vncMode,
    vncSessionId,
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
    taskId: taskId ?? "all",
    chatId: chatId ?? "all",
    agentId: agentId ?? "all",
    agentRunId: agentRunId ?? "all",
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

  if (vncMode && vncSessionId) {
    void vncSessionManager.openTcpSocket(vncSessionId).then(({ socket }) => {
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

  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: "connected",
    taskId: taskId ?? null,
    chatId: chatId ?? null,
    agentId: agentId ?? null,
    agentRunId: agentRunId ?? null,
    sshSessionId: sshSessionId ?? null,
    sshServerSessionId: sshServerSessionId ?? null,
    provisioningJobId: provisioningJobId ?? null,
  }));

  const hasScopedSubscription = Boolean(
    taskId || chatId || agentId || agentRunId || sshSessionId || sshServerSessionId || provisioningJobId,
  );
  const shouldSubscribeToAllRuntimeEvents = !hasScopedSubscription;

  const shouldSubscribeToTaskEvents = shouldSubscribeToAllRuntimeEvents || !!taskId;
  const taskUnsubscribe = shouldSubscribeToTaskEvents
    ? taskEventEmitter.subscribe((event: TaskEvent) => {
        if (taskId && "taskId" in event && event.taskId !== taskId) {
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
        if (!chatId && getChatEventScope(event) === "agent") {
          return;
        }
        try {
          ws.send(JSON.stringify(event));
        } catch (sendError) {
          log.trace("Failed to send chat event to WebSocket client", { error: String(sendError) });
        }
      })
    : undefined;

  const shouldSubscribeToAgentEvents = shouldSubscribeToAllRuntimeEvents || !!agentId || !!agentRunId;
  const agentUnsubscribe = shouldSubscribeToAgentEvents
    ? agentEventEmitter.subscribe((event: AgentEvent) => {
        if (agentId && event.agentId !== agentId) {
          return;
        }
        if (agentRunId && "agentRunId" in event && event.agentRunId !== agentRunId) {
          return;
        }

        try {
          ws.send(JSON.stringify(event));
        } catch (sendError) {
          log.trace("Failed to send agent event to WebSocket client", { error: String(sendError) });
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
    ...(taskUnsubscribe ? [taskUnsubscribe] : []),
    ...(chatUnsubscribe ? [chatUnsubscribe] : []),
    ...(agentUnsubscribe ? [agentUnsubscribe] : []),
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

  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
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
    taskId: ws.data.taskId,
    chatId: ws.data.chatId,
    agentId: ws.data.agentId,
    agentRunId: ws.data.agentRunId,
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
  if (ws.data.vncSocket) {
    ws.data.vncSocket.destroy();
    ws.data.vncSocket = undefined;
  }
  if (ws.data.unsubscribers) {
    for (const unsubscribe of ws.data.unsubscribers) {
      unsubscribe();
    }
    ws.data.unsubscribers = undefined;
  }
}
