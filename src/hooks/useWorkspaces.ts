/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces and fetches workspace list.
 */

import { useCallback, useState } from "react";
import type {
  PublicWorkspace,
  PublicWorkspaceSummary,
  Workspace,
} from "@/shared/workspace";
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import { createLogger, useLiveQuery } from "@pablozaiden/webapp/web";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";

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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const query = useLiveQuery<PublicWorkspace[]>({
    load: async (signal) => {
      const workspaces = await apiRequest<PublicWorkspaceSummary[]>("/api/workspaces", {
        signal,
        action: "Load workspaces",
        fallbackMessage: "Failed to fetch workspaces",
      });
      return workspaces.map((workspace) => ({ ...workspace, scratchpad: "" }));
    },
    realtime: { resources: ["workspaces"] },
  });
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  // Create a new workspace
  const createWorkspace = useCallback(async (request: CreateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      return await mutate(async (signal) => {
        const response = await requestApiResponse("/api/workspaces", {
          signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          action: "Create workspace",
          fallbackMessage: "Failed to create workspace",
          acceptedStatuses: [409],
        });
        const data = await readApiResponse<Workspace & { existingWorkspace?: Workspace }>(response);
        return response.status === 409 && data.existingWorkspace ? data.existingWorkspace : data;
      });
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
  }, [mutate]);

  // Update a workspace
  const updateWorkspace = useCallback(async (id: string, request: string | UpdateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const body = typeof request === "string" ? { name: request } : request;
      return await mutate((signal) => apiRequest<Workspace>(`/api/workspaces/${id}`, {
        signal,
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        action: "Update workspace",
        fallbackMessage: "Failed to update workspace",
      }));
    } catch (err) {
      log.error("Failed to update workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, [mutate]);

  // Delete a workspace
  const deleteWorkspace = useCallback(async (
    id: string,
    options: DeleteWorkspaceRequest = {},
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      await mutate((signal) => apiRequest(`/api/workspaces/${id}`, {
        signal,
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
        action: "Delete workspace",
        fallbackMessage: "Failed to delete workspace",
      }), (previous) => previous?.filter((workspace) => workspace.id !== id));
      return { success: true };
    } catch (err) {
      log.error("Failed to delete workspace", { workspaceId: id, error: String(err) });
      setError(String(err));
      return { success: false, error: String(err) };
    } finally {
      setSaving(false);
    }
  }, [mutate]);

  const pullLatestChanges = useCallback(async (
    id: string,
  ): Promise<{ success: boolean; defaultBranch?: string; currentBranch?: string; error?: string }> => {
    try {
      setSaving(true);
      setError(null);
      const body = await mutate((signal) => apiRequest<{
        defaultBranch?: string;
        currentBranch?: string;
        message?: string;
      }>(`/api/workspaces/${id}/pull-latest-changes`, {
        signal,
        method: "POST",
        action: "Pull latest workspace changes",
        fallbackMessage: "Failed to pull latest changes",
      }));
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
  }, [mutate]);

  return {
    workspaces: query.data ?? [],
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
    saving,
    refresh,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    pullLatestChanges,
  };
}
