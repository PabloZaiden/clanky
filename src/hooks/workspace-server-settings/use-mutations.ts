import { useCallback, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { ServerSettings } from "@/shared/settings";
import type { ExecutionHostRef } from "@/shared";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
import { apiRequest } from "../../lib/api-client";

export function useWorkspaceMutations(
  workspaceId: string | null,
  fetchWorkspace: () => Promise<void>,
  fetchStatus: () => Promise<void>,
  setError: (error: string | null) => void,
) {
  const log = createLogger("useWorkspaceMutations");
  const [saving, setSaving] = useState(false);

  const updateSettings = useCallback(async (newSettings: ServerSettings): Promise<boolean> => {
    if (!workspaceId) {
      setError("No workspace selected");
      return false;
    }

    try {
      setSaving(true);
      setError(null);

      await apiRequest(`/api/workspaces/${workspaceId}/server-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
        action: "Save workspace server settings",
        fallbackMessage: "Failed to save settings",
      });

      // Refresh workspace to get updated data from API (avoid stale data)
      await fetchWorkspace();

      // Refresh status after settings change
      await fetchStatus();

      return true;
    } catch (err) {
      log.error("Failed to update workspace server settings", {
        workspaceId,
        error: String(err),
      });
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [workspaceId, fetchWorkspace, fetchStatus, setError]);

  const updateName = useCallback(async (name: string): Promise<boolean> => {
    if (!workspaceId) {
      setError("No workspace selected");
      return false;
    }

    try {
      setSaving(true);
      setError(null);

      await apiRequest(`/api/workspaces/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        action: "Update workspace name",
        fallbackMessage: "Failed to update name",
      });

      // Refresh workspace to get updated data from API (avoid stale data)
      await fetchWorkspace();

      return true;
    } catch (err) {
      log.error("Failed to update workspace name", {
        workspaceId,
        error: String(err),
      });
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [workspaceId, fetchWorkspace, setError]);

  const updateWorkspace = useCallback(async (
    name: string,
    settings: ServerSettings,
    executionHost: ExecutionHostRef | null,
    sshTarget: WorkspaceSshTargetRequest | null,
    archived: boolean,
    allowClankyContext: boolean,
  ): Promise<boolean> => {
    if (!workspaceId) {
      setError("No workspace selected");
      return false;
    }

    try {
      setSaving(true);
      setError(null);

      await apiRequest(`/api/workspaces/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          serverSettings: settings,
          ...(executionHost ? { executionHost } : {}),
          ...(sshTarget ? { sshTarget } : {}),
          archived,
          allowClankyContext,
        }),
        action: "Update workspace",
        fallbackMessage: "Failed to update workspace",
      });

      // Refresh workspace to get updated data from API (avoid stale data)
      await fetchWorkspace();

      // Refresh status after settings change
      await fetchStatus();

      return true;
    } catch (err) {
      log.error("Failed to update workspace and settings", {
        workspaceId,
        error: String(err),
      });
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [workspaceId, fetchWorkspace, fetchStatus, setError]);

  return { saving, updateSettings, updateName, updateWorkspace };
}
