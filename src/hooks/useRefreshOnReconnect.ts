import { useEffect, useRef } from "react";
import type { WebSocketConnectionStatus } from "./useWebSocket";

interface UseRefreshOnReconnectOptions {
  status: WebSocketConnectionStatus;
  onReconnect: () => void | Promise<void>;
  resetKey?: string;
  enabled?: boolean;
}

export function useRefreshOnReconnect({
  status,
  onReconnect,
  resetKey,
  enabled = true,
}: UseRefreshOnReconnectOptions): void {
  const hasOpenedRef = useRef(false);
  const reconnectPendingRef = useRef(false);

  useEffect(() => {
    hasOpenedRef.current = false;
    reconnectPendingRef.current = false;
  }, [resetKey]);

  useEffect(() => {
    if (!enabled) {
      hasOpenedRef.current = false;
      reconnectPendingRef.current = false;
      return;
    }

    if (status === "open") {
      if (hasOpenedRef.current && reconnectPendingRef.current) {
        reconnectPendingRef.current = false;
        void onReconnect();
      }
      hasOpenedRef.current = true;
      return;
    }

    if (status === "error" && hasOpenedRef.current) {
      reconnectPendingRef.current = true;
    }
  }, [enabled, onReconnect, resetKey, status]);
}
