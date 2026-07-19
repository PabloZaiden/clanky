import { useCallback, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { ServerSettings } from "@/shared/settings";
import { appFetch } from "../../lib/public-path";

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

      const response = await appFetch(`/api/workspaces/${workspaceId}/server-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to save settings");
      }

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

      const response = await appFetch(`/api/workspaces/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update name");
      }

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

      const response = await appFetch(`/api/workspaces/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, serverSettings: settings, archived, allowClankyContext }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to update workspace");
      }

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
