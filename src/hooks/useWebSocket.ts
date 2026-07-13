/**
 * Compatibility hook backed by the webapp framework realtime client.
 *
 * Clanky still consumes the historical hook shape in several views, while
 * connection lifecycle and reconnect behavior now belong to webapp.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@pablozaiden/webapp/web";

export type WebSocketConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface UseWebSocketOptions<T> {
  url: string;
  autoConnect?: boolean;
  onEvent?: (event: T) => void;
  onStatusChange?: (status: WebSocketConnectionStatus) => void;
  maxEvents?: number;
}

export interface UseWebSocketResult<T> {
  events: T[];
  status: WebSocketConnectionStatus;
  connect: () => void;
  disconnect: () => void;
  clearEvents: () => void;
}

function realtimePath(url: string): string {
  try {
    const parsed = new URL(url, "http://clanky.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function useWebSocket<T = unknown>(options: UseWebSocketOptions<T>): UseWebSocketResult<T> {
  const {
    url,
    autoConnect = true,
    onEvent,
    onStatusChange,
    maxEvents = 1000,
  } = options;
  const [enabled, setEnabled] = useState(autoConnect);
  const [manuallyDisconnected, setManuallyDisconnected] = useState(!autoConnect);
  const [events, setEvents] = useState<T[]>([]);
  const hasOpenedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);
  const maxEventsRef = useRef(maxEvents);

  onEventRef.current = onEvent;
  onStatusChangeRef.current = onStatusChange;
  maxEventsRef.current = maxEvents;

  useEffect(() => {
    setEnabled(autoConnect);
    setManuallyDisconnected(!autoConnect);
  }, [autoConnect]);

  const path = useMemo(() => realtimePath(url), [url]);
  const handleEvent = useCallback((event: T) => {
    setEvents((previous) => {
      const next = [...previous, event];
      const max = maxEventsRef.current;
      if (max <= 0) {
        return [];
      }
      return next.length > max ? next.slice(-max) : next;
    });
    onEventRef.current?.(event);
  }, []);

  const realtime = useRealtime<T>({
    enabled,
    path,
    onEvent: handleEvent,
  });

  useEffect(() => {
    if (realtime.status === "open") {
      hasOpenedRef.current = true;
    }
  }, [realtime.status]);

  const status: WebSocketConnectionStatus = realtime.status === "closed"
    && hasOpenedRef.current
    && !manuallyDisconnected
    ? "error"
    : realtime.status;

  useEffect(() => {
    onStatusChangeRef.current?.(status);
  }, [status]);

  const connect = useCallback(() => {
    setManuallyDisconnected(false);
    setEnabled(true);
  }, []);

  const disconnect = useCallback(() => {
    setManuallyDisconnected(true);
    setEnabled(false);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return {
    events,
    status,
    connect,
    disconnect,
    clearEvents,
  };
}

export function useGlobalEvents<T = unknown>(
  options?: Omit<UseWebSocketOptions<T>, "url">,
): UseWebSocketResult<T> {
  return useWebSocket<T>({
    url: "/api/ws",
    ...options,
  });
}

export function useTaskEvents<T = unknown>(
  taskId: string,
  options?: Omit<UseWebSocketOptions<T>, "url">,
): UseWebSocketResult<T> {
  return useWebSocket<T>({
    url: `/api/ws?taskId=${encodeURIComponent(taskId)}`,
    ...options,
  });
}
