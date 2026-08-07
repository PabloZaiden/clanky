import { useCallback, useState } from "react";
import type { ConnectionStatus } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { log } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";

export function useWorkspaceFetch(workspaceId: string | null) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspace = useCallback(async () => {
    if (!workspaceId) {
      setWorkspace(null);
      return;
    }

    try {
      const data = await apiRequest<Workspace>(`/api/workspaces/${workspaceId}?sensitive=true`, {
        action: "Load workspace",
        fallbackMessage: "Failed to fetch workspace",
      });
      setWorkspace(data);
    } catch (err) {
      setError(String(err));
    }
  }, [workspaceId]);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }

    try {
      const data = await apiRequest<ConnectionStatus>(`/api/workspaces/${workspaceId}/server-settings/status`, {
        action: "Load workspace connection status",
        fallbackMessage: "Failed to fetch status",
      });
      setStatus(data);
    } catch (err) {
      // Don't set error for status fetch failures - non-critical
      log.error("Failed to fetch connection status:", err);
    }
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([fetchWorkspace(), fetchStatus()]);
    setLoading(false);
  }, [fetchWorkspace, fetchStatus]);

  return { workspace, setWorkspace, status, setStatus, loading, setLoading, error, setError, fetchWorkspace, fetchStatus, refresh };
}
