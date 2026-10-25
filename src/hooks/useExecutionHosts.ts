import type { ExecutionHostDescriptor } from "@/shared";
import { apiRequest } from "../lib/api-client";
import { useLiveQuery } from "@pablozaiden/webapp/web";

export function useExecutionHosts({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useLiveQuery<ExecutionHostDescriptor[]>({
    enabled,
    load: (signal) => apiRequest<ExecutionHostDescriptor[]>("/api/execution-hosts", {
      signal,
      action: "Load execution hosts",
      fallbackMessage: "Failed to load execution hosts",
    }),
    realtime: { resources: ["execution-hosts", "mesh"] },
  });

  return {
    hosts: query.data ?? [],
    loading: query.data === undefined && query.loading,
    error: query.error ? String(query.error) : null,
    refresh: query.refresh,
  };
}
