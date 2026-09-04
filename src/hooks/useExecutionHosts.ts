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

  const refresh = useCallback((options: ResourceRefreshOptions = {}) => (
    coordinator.current.run(async () => {
      if (options.showLoading ?? true) {
        setLoading(true);
      }
      try {
        setError(null);
        setHosts(await apiRequest<ExecutionHostDescriptor[]>("/api/execution-hosts", {
          action: "Load execution hosts",
          fallbackMessage: "Failed to load execution hosts",
        }));
      } catch (refreshError) {
        setError(String(refreshError));
      } finally {
        if (options.showLoading ?? true) {
          setLoading(false);
        }
      }
    })
  ), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtimeRefreshWithRecovery({
    resources: ["execution-hosts", "mesh"],
    refresh: async () => await refresh({ showLoading: false }),
    onReconnect: async () => await refresh({ showLoading: false }),
  });

  return { hosts, loading, error, refresh };
}
