import { useCallback, useState } from "react";
import type { ConnectionStatus } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { log } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";

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
      const response = await appFetch(`/api/workspaces/${workspaceId}?sensitive=true`);
      if (!response.ok) {
        throw new Error(`Failed to fetch workspace: ${response.statusText}`);
      }
      const data = (await response.json()) as Workspace;
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
      const response = await appFetch(`/api/workspaces/${workspaceId}/server-settings/status`);
      if (!response.ok) {
        throw new Error(`Failed to fetch status: ${response.statusText}`);
      }
      const data = (await response.json()) as ConnectionStatus;
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
