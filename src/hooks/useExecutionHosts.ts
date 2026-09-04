import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecutionHostDescriptor } from "@/shared";
import { apiRequest } from "../lib/api-client";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { useRealtimeRefreshWithRecovery } from "./useRealtimeStream";
import type { ResourceRefreshOptions } from "./useResourceRefresh";

export function useExecutionHosts() {
  const [hosts, setHosts] = useState<ExecutionHostDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const coordinator = useRef(createRefreshCoordinator<void>());
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(false);

  const refresh = useCallback((options: ResourceRefreshOptions = {}) => (
    coordinator.current.run(async () => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      if ((options.showLoading ?? true) && isMountedRef.current) {
        setLoading(true);
      }
      try {
        if (isMountedRef.current) {
          setError(null);
        }
        const nextHosts = await apiRequest<ExecutionHostDescriptor[]>("/api/execution-hosts", {
          signal: controller.signal,
          action: "Load execution hosts",
          fallbackMessage: "Failed to load execution hosts",
        });
        if (!controller.signal.aborted && isMountedRef.current) {
          setHosts(nextHosts);
        }
      } catch (refreshError) {
        if (!controller.signal.aborted && isMountedRef.current) {
          setError(String(refreshError));
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if ((options.showLoading ?? true) && !controller.signal.aborted && isMountedRef.current) {
          setLoading(false);
        }
      }
    })
  ), []);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      coordinator.current.reset();
    };
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["execution-hosts", "mesh"],
    refresh: async () => await refresh({ showLoading: false }),
    onReconnect: async () => await refresh({ showLoading: false }),
  });

  return { hosts, loading, error, refresh };
}
