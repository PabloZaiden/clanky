/**
 * Narrow adapter for incremental application streams.
 *
 * Resource invalidation belongs to useRealtimeRefresh. This hook is only for
 * deltas that would be unnecessarily expensive or disruptive to recover by
 * refetching the complete entity.
 */

import { useEffect, useRef } from "react";
import {
  useRealtime,
  useRealtimeRefresh,
  type RealtimeEventSelector,
  type RealtimeStatus,
  type ResourceRealtimeEvent,
} from "@pablozaiden/webapp/web";

export type RealtimeStreamStatus = RealtimeStatus | "error";

export interface UseRealtimeStreamOptions<T> {
  enabled?: boolean;
  path?: string;
  filters?: Record<string, string | undefined>;
  predicate?: (event: T) => boolean;
  onEvent?: (event: T) => void;
  onReconnect?: () => void | Promise<void>;
}

export interface UseRealtimeStreamResult {
  status: RealtimeStreamStatus;
}

function useReconnectRecovery(
  status: RealtimeStatus,
  enabled: boolean,
  onReconnect: (() => void | Promise<void>) | undefined,
): void {
  const hasOpenedRef = useRef(false);
  const disconnectedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      hasOpenedRef.current = false;
      disconnectedRef.current = false;
      return;
    }

    if (status === "open") {
      if (disconnectedRef.current) {
        disconnectedRef.current = false;
        void onReconnect?.();
      }
      hasOpenedRef.current = true;
      return;
    }

    if (status === "closed" && hasOpenedRef.current) {
      disconnectedRef.current = true;
    }
  }, [enabled, onReconnect, status]);
}

export function useRealtimeStream<T = unknown>({
  enabled = true,
  path,
  filters,
  predicate,
  onEvent,
  onReconnect,
}: UseRealtimeStreamOptions<T> = {}): UseRealtimeStreamResult {
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  onEventRef.current = onEvent;
  onReconnectRef.current = onReconnect;

  const realtime = useRealtime<T>({
    enabled,
    path,
    filters,
    onEvent: (event) => {
      if (predicate && !predicate(event)) {
        return;
      }
      onEventRef.current?.(event);
    },
  });

  useReconnectRecovery(realtime.status, enabled, () => onReconnectRef.current?.());

  return {
    status: realtime.status === "closed" && enabled
      ? "error"
      : realtime.status,
  };
}

export interface UseRealtimeRefreshWithRecoveryOptions<T> extends RealtimeEventSelector<T> {
  refresh: (event: T) => void | Promise<void>;
  enabled?: boolean;
  path?: string;
  filters?: Record<string, string | undefined>;
  onEvent?: (event: T) => void;
  onReconnect?: () => void | Promise<void>;
}

export function useRealtimeRefreshWithRecovery<T = ResourceRealtimeEvent>({
  onReconnect,
  enabled = true,
  ...options
}: UseRealtimeRefreshWithRecoveryOptions<T>) {
  const realtime = useRealtimeRefresh<T>({
    ...options,
    enabled,
  });
  useReconnectRecovery(realtime.status, enabled, onReconnect);
  return realtime;
}
