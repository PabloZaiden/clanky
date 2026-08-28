/**
 * Workspace server settings state management hook.
 * Provides access to workspace-specific server settings and connection status.
 *
 * IMPORTANT: This hook fetches fresh data from the API to avoid using stale in-memory data.
 * Always use the data from this hook rather than from the workspaces list.
 */

import { useEffect } from "react";
import { useWorkspaceFetch } from "./use-fetch";
import { useWorkspaceMutations } from "./use-mutations";
import { useWorkspaceConnection } from "./use-connection";
export type { UseWorkspaceServerSettingsResult } from "./types";
export { useWorkspaceExecutionTargets } from "./use-execution-targets";

/**
 * Hook for managing workspace-specific server settings.
 *
 * IMPORTANT: This hook fetches fresh workspace data from the API to avoid stale in-memory data.
 * Always use workspace/settings from this hook rather than from the workspaces list.
 *
 * @param workspaceId - The ID of the workspace to manage settings for
 */
export function useWorkspaceServerSettings(workspaceId: string | null) {
  const {
    workspace,
    setWorkspace,
    status,
    setStatus,
    loading,
    setLoading,
    error,
    setError,
    fetchWorkspace,
    fetchStatus,
    refresh,
  } = useWorkspaceFetch(workspaceId);

  const { saving, updateSettings, updateName, updateWorkspace } = useWorkspaceMutations(
    workspaceId,
    fetchWorkspace,
    fetchStatus,
    setError,
  );

  const { testing, testConnection } = useWorkspaceConnection(
    workspaceId,
    setError,
  );

  // Fetch when workspace changes
  useEffect(() => {
    if (workspaceId) {
      refresh();
    } else {
      setWorkspace(null);
      setStatus(null);
      setLoading(false);
    }
  }, [workspaceId, refresh, setWorkspace, setStatus, setLoading]);

  return {
    workspace,
    settings: workspace?.serverSettings ?? null,
    status,
    loading,
    error,
    saving,
    testing,
    refresh,
    updateSettings,
    updateName,
    updateWorkspace,
    testConnection,
  };
}
