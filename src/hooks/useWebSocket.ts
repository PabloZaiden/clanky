/**
 * WebSocket hook for real-time event streaming.
 * Provides connectivity to the Clanky events API.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { appWebSocketUrl } from "../lib/public-path";
import { log } from "../lib/logger";

export type WebSocketConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface UseWebSocketOptions<T> {
  /** URL to connect to (WebSocket endpoint) */
  url: string;
  /** Whether to automatically connect on mount */
  autoConnect?: boolean;
  /** Callback when an event is received */
  onEvent?: (event: T) => void;
  /** Callback when connection status changes */
  onStatusChange?: (status: WebSocketConnectionStatus) => void;
  /** Maximum number of events to keep in history */
  maxEvents?: number;
}

export interface UseWebSocketResult<T> {
  /** Array of received events */
  events: T[];
  /** Current connection status */
  status: WebSocketConnectionStatus;
  /** Connect to the WebSocket endpoint */
  connect: () => void;
  /** Disconnect from the WebSocket endpoint */
  disconnect: () => void;
  /** Clear all stored events */
  clearEvents: () => void;
}

/**
 * Build WebSocket URL from current location.
 * Handles both HTTP->WS and HTTPS->WSS protocol conversion.
 */
function buildWebSocketUrl(path: string): string {
  return appWebSocketUrl(path);
}

/**
 * Hook for connecting to WebSocket events endpoint.
 */
export function useWebSocket<T = unknown>(options: UseWebSocketOptions<T>): UseWebSocketResult<T> {
  const { url, autoConnect = true, onEvent, onStatusChange, maxEvents = 1000 } = options;

  const [events, setEvents] = useState<T[]>([]);
  const [status, setStatus] = useState<WebSocketConnectionStatus>("closed");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const isManualDisconnectRef = useRef(false);
  const activeConnectionIdRef = useRef(0);

  // Use refs for callbacks to avoid re-triggering effects
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);
  const maxEventsRef = useRef(maxEvents);

  // Keep refs up to date
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    maxEventsRef.current = maxEvents;
  }, [maxEvents]);

  // Update status and call callback
  const updateStatus = useCallback((newStatus: WebSocketConnectionStatus) => {
    setStatus(newStatus);
    onStatusChangeRef.current?.(newStatus);
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const closeCurrentSocket = useCallback((advanceConnectionId: boolean) => {
    if (advanceConnectionId) {
      activeConnectionIdRef.current += 1;
    }
    const currentSocket = wsRef.current;
    wsRef.current = null;
    if (currentSocket) {
      currentSocket.close();
    }
  }, []);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true;
    clearReconnectTimeout();
    closeCurrentSocket(true);
    updateStatus("closed");
  }, [clearReconnectTimeout, closeCurrentSocket, updateStatus]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    const connectionId = activeConnectionIdRef.current + 1;
    activeConnectionIdRef.current = connectionId;
    isManualDisconnectRef.current = false;

    // Clear any pending reconnect
    clearReconnectTimeout();

    // Close existing connection
    closeCurrentSocket(false);

    updateStatus("connecting");

    // Convert HTTP URL to WebSocket URL
    const wsUrl = buildWebSocketUrl(url);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (activeConnectionIdRef.current !== connectionId || wsRef.current !== ws) {
        return;
      }
      reconnectAttemptRef.current = 0; // Reset reconnect attempts on successful connection
      updateStatus("open");
    };

    ws.onmessage = (event) => {
      if (activeConnectionIdRef.current !== connectionId || wsRef.current !== ws) {
        return;
      }
      try {
        const data = JSON.parse(event.data) as T & { type?: string };

        // Skip connection confirmation and pong messages
        if (data.type === "connected" || data.type === "pong") {
          return;
        }

        setEvents((prev) => {
          const newEvents = [...prev, data];
          if (newEvents.length > maxEventsRef.current) {
            return newEvents.slice(-maxEventsRef.current);
          }
          return newEvents;
        });
        onEventRef.current?.(data);
      } catch {
        log.warn("Failed to parse WebSocket message:", event.data);
      }
    };

    ws.onerror = () => {
      if (activeConnectionIdRef.current !== connectionId || wsRef.current !== ws) {
        return;
      }
      // Error will be followed by close, let close handler manage status
    };

    ws.onclose = () => {
      if (activeConnectionIdRef.current !== connectionId || wsRef.current !== ws) {
        return;
      }
      wsRef.current = null;

      // Don't reconnect if manually disconnected
      if (isManualDisconnectRef.current) {
        updateStatus("closed");
        return;
      }

      updateStatus("error");

      // Exponential backoff for reconnection (max 30 seconds)
      const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 30000);
      reconnectAttemptRef.current++;

      reconnectTimeoutRef.current = setTimeout(() => {
        if (activeConnectionIdRef.current !== connectionId) {
          return;
        }
        connect();
      }, backoffMs);
    };
  }, [clearReconnectTimeout, closeCurrentSocket, url, updateStatus]);

  // Clear events
  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  // Auto-connect when enabled and keep the stable callback deps aligned with the current socket lifecycle.
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    // Cleanup on unmount or URL change
    return () => {
      isManualDisconnectRef.current = true;
      clearReconnectTimeout();
      closeCurrentSocket(true);
    };
  }, [autoConnect, clearReconnectTimeout, closeCurrentSocket, connect, url]);

  return {
    events,
    status,
    connect,
    disconnect,
    clearEvents,
  };
}

/**
 * Convenience hook for connecting to the global events endpoint.
 */
export function useGlobalEvents<T = unknown>(
  options?: Omit<UseWebSocketOptions<T>, "url">
): UseWebSocketResult<T> {
  return useWebSocket<T>({
    url: "/api/ws",
    ...options,
  });
}

/**
 * Convenience hook for connecting to a task-specific events endpoint.
 */
export function useTaskEvents<T = unknown>(
  taskId: string,
  options?: Omit<UseWebSocketOptions<T>, "url">
): UseWebSocketResult<T> {
  return useWebSocket<T>({
    url: `/api/ws?taskId=${encodeURIComponent(taskId)}`,
    ...options,
  });
}
