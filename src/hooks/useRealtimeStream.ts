/**
 * Narrow adapter for incremental application streams.
 *
 * Resource invalidation belongs to useRealtimeRefresh. This hook is only for
 * deltas that would be unnecessarily expensive or disruptive to recover by
 * refetching the complete entity.
 */

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

export function useRealtimeStream<T = unknown>({
  enabled = true,
  path,
  filters,
  predicate,
  onEvent,
  onReconnect,
}: UseRealtimeStreamOptions<T> = {}): UseRealtimeStreamResult {
  const realtime = useRealtime<T>({
    enabled,
    path,
    filters,
    predicate,
    trackLastEvent: false,
    onEvent,
    onOpen: onReconnect,
  });

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
  return useRealtimeRefresh<T>({
    ...options,
    enabled,
    trackLastEvent: false,
    onOpen: onReconnect,
  });
}
