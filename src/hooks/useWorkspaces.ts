/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces and fetches workspace list.
 */

import { useCallback, useEffect, useState } from "react";
import type { PublicWorkspace, Workspace } from "@/shared/workspace";
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import { useResourceRefresh } from "./useResourceRefresh";

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
  updateWorkspace: (id: string, request: string | UpdateWorkspaceRequest) => Promise<Workspace | null>;
  /** Delete a workspace (only if it has no tasks) */
  deleteWorkspace: (id: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  /** Pull latest changes for the workspace default branch */
  pullLatestChanges: (
    id: string,
  ) => Promise<{ success: boolean; defaultBranch?: string; currentBranch?: string; error?: string }>;
}

/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces.
 */
export function useWorkspaces(): UseWorkspacesResult {
  const log = createLogger("useWorkspaces");
  const [workspaces, setWorkspaces] = useState<PublicWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadWorkspaces = useCallback(async (signal: AbortSignal): Promise<PublicWorkspace[]> => {
    return await apiRequest<PublicWorkspace[]>("/api/workspaces", {
      signal,
      action: "Load workspaces",
      fallbackMessage: "Failed to fetch workspaces",
    });
  }, []);

  const handleRefreshError = useCallback((refreshError: unknown) => {
    log.error("Failed to fetch workspaces", { error: String(refreshError) });
    setError(String(refreshError));
  }, []);

  const refreshResource = useResourceRefresh({
    load: loadWorkspaces,
    onLoaded: setWorkspaces,
    onRefreshStart: () => setError(null),
    onError: handleRefreshError,
  });

  const refresh = useCallback(async () => {
    await refreshResource.refresh();
  }, [refreshResource.refresh]);

  // Create a new workspace
  const createWorkspace = useCallback(async (request: CreateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const response = await requestApiResponse("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create workspace",
        fallbackMessage: "Failed to create workspace",
        acceptedStatuses: [409],
      });
      const data = await readApiResponse<Workspace & { existingWorkspace?: Workspace }>(response);
      if (response.status === 409 && data.existingWorkspace) {
        return data.existingWorkspace;
      }
      // Refresh the list to include the new workspace
      await refresh();
      return data;
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
  }, [refresh]);

  // Update a workspace
  const updateWorkspace = useCallback(async (id: string, request: string | UpdateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const body = typeof request === "string" ? { name: request } : request;
      const workspace = await apiRequest<Workspace>(`/api/workspaces/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        action: "Update workspace",
        fallbackMessage: "Failed to update workspace",
      });
      // Refresh the list to include the updated workspace
      await refresh();
      return workspace;
    } catch (err) {
      log.error("Failed to update workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  // Delete a workspace
  const deleteWorkspace = useCallback(async (
    id: string,
    options: DeleteWorkspaceRequest = {},
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      await apiRequest(`/api/workspaces/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
        action: "Delete workspace",
        fallbackMessage: "Failed to delete workspace",
      });
      // Refresh the list to exclude the deleted workspace
      await refresh();
      return { success: true };
    } catch (err) {
      log.error("Failed to delete workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const pullLatestChanges = useCallback(async (
    id: string,
  ): Promise<{ success: boolean; defaultBranch?: string; currentBranch?: string; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      const body = await apiRequest<{
        defaultBranch?: string;
        currentBranch?: string;
        message?: string;
      }>(`/api/workspaces/${id}/pull-latest-changes`, {
        method: "POST",
        action: "Pull latest workspace changes",
        fallbackMessage: "Failed to pull latest changes",
      });
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    workspaces,
    loading: refreshResource.loading,
    error,
    saving,
    refresh,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    pullLatestChanges,
  };
}
