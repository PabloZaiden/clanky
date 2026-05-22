/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces and fetches workspace list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PublicWorkspace,
  Workspace,
  CreateWorkspaceRequest,
  DeleteWorkspaceRequest,
  WorkspaceImportResult,
  WorkspaceExportData,
} from "../types/workspace";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";

export interface UseWorkspacesResult {
  /** List of workspaces */
  workspaces: PublicWorkspace[];
  /** Whether workspaces are being loaded */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether a create/update/delete operation is in progress */
  saving: boolean;
  /** Refresh the workspaces list */
  refresh: () => Promise<void>;
  /** Create a new workspace */
  createWorkspace: (request: CreateWorkspaceRequest) => Promise<Workspace | null>;
  /** Update a workspace */
  updateWorkspace: (id: string, name: string) => Promise<Workspace | null>;
  /** Delete a workspace (only if it has no tasks) */
  deleteWorkspace: (id: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Pull latest changes for the workspace default branch */
  pullLatestChanges: (
    id: string,
  ) => Promise<{ success: boolean; defaultBranch?: string; currentBranch?: string; error?: string }>;
  /** Fetch all workspace configs as JSON from the export API */
  exportConfig: () => Promise<WorkspaceExportData | null>;
  /** Import workspace configs from a JSON object */
  importConfig: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;
}

/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces.
 */
export function useWorkspaces(): UseWorkspacesResult {
  const log = createLogger("useWorkspaces");
  const [workspaces, setWorkspaces] = useState<PublicWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // AbortController for cancelling in-flight import requests on unmount.
  // Import can take a while when validating many workspaces against remote servers.
  const importAbortRef = useRef<AbortController | null>(null);

  // Fetch all workspaces
  const fetchWorkspaces = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/workspaces");
      if (!response.ok) {
        throw new Error(`Failed to fetch workspaces: ${response.statusText}`);
      }
      const data = (await response.json()) as PublicWorkspace[];
      setWorkspaces(data);
    } catch (err) {
      log.error("Failed to fetch workspaces", { error: String(err) });
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Create a new workspace
  const createWorkspace = useCallback(async (request: CreateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorData = await response.json() as { message?: string; existingWorkspace?: Workspace };
        // If workspace already exists, return it
        if (response.status === 409 && errorData.existingWorkspace) {
          return errorData.existingWorkspace;
        }
        throw new Error(errorData.message || "Failed to create workspace");
      }

      const workspace = (await response.json()) as Workspace;
      // Refresh the list to include the new workspace
      await fetchWorkspaces();
      return workspace;
    } catch (err) {
      log.error("Failed to create workspace", {
        workspaceName: request.name,
        directory: request.directory,
        error: String(err),
      });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [fetchWorkspaces]);

  // Update a workspace
  const updateWorkspace = useCallback(async (id: string, name: string): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch(`/api/workspaces/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to update workspace");
      }

      const workspace = (await response.json()) as Workspace;
      // Refresh the list to include the updated workspace
      await fetchWorkspaces();
      return workspace;
    } catch (err) {
      log.error("Failed to update workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [fetchWorkspaces]);

  // Delete a workspace
  const deleteWorkspace = useCallback(async (
    id: string,
    options: DeleteWorkspaceRequest = {},
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch(`/api/workspaces/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });

      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        const message = errorData.message || "Failed to delete workspace";
        log.error("Failed to delete workspace", { workspaceId: id, error: message });
        return { success: false, error: message };
      }

      // Refresh the list to exclude the deleted workspace
      await fetchWorkspaces();
      return { success: true };
    } catch (err) {
      log.error("Failed to delete workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setSaving(false);
    }
  }, [fetchWorkspaces]);

  const pullLatestChanges = useCallback(async (
    id: string,
  ): Promise<{ success: boolean; defaultBranch?: string; currentBranch?: string; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch(`/api/workspaces/${id}/pull-latest-changes`, {
        method: "POST",
      });

      const body = await response.json() as {
        defaultBranch?: string;
        currentBranch?: string;
        message?: string;
      };

      if (!response.ok) {
        const message = body.message || "Failed to pull latest changes";
        log.warn("Failed to pull latest changes", { workspaceId: id, error: message });
        return { success: false, error: message };
      }

      return {
        success: true,
        defaultBranch: body.defaultBranch,
        currentBranch: body.currentBranch,
      };
    } catch (err) {
      log.error("Failed to pull latest changes", { workspaceId: id, error: String(err) });
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setSaving(false);
    }
  }, []);

  // Export all workspace configs
  const exportConfig = useCallback(async (): Promise<WorkspaceExportData | null> => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/workspaces/export?sensitive=true");
      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to export workspaces");
      }
      return (await response.json()) as WorkspaceExportData;
    } catch (err) {
      log.error("Failed to export workspaces", { error: String(err) });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  // Import workspace configs
  const importConfig = useCallback(async (data: WorkspaceExportData): Promise<WorkspaceImportResult | null> => {
    // Abort any previous in-flight import request
    importAbortRef.current?.abort();
    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/workspaces/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return null;

      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || "Failed to import workspaces");
      }

      const result = (await response.json()) as WorkspaceImportResult;
      // Refresh the list to include newly imported workspaces
      await fetchWorkspaces();
      return result;
    } catch (err) {
      // Don't set error state if the request was intentionally aborted
      if (controller.signal.aborted) return null;
      log.error("Failed to import workspaces", { error: String(err) });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [fetchWorkspaces]);

  // Initial fetch
  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Cleanup: abort any in-flight import request on unmount
  useEffect(() => {
    return () => {
      importAbortRef.current?.abort();
    };
  }, []);

  return {
    workspaces,
    loading,
    error,
    saving,
    refresh: fetchWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    pullLatestChanges,
    exportConfig,
    importConfig,
  };
}
