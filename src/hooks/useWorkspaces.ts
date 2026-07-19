/**
 * Hook for managing workspaces.
 * Provides CRUD operations for workspaces and fetches workspace list.
 */

import { useCallback, useEffect, useState } from "react";
import type { PublicWorkspace, Workspace } from "@/shared/workspace";
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import { createLogger } from "@pablozaiden/webapp/web";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
  const updateWorkspace = useCallback(async (id: string, request: string | UpdateWorkspaceRequest): Promise<Workspace | null> => {
    try {
      setSaving(true);
      setError(null);
      const body = typeof request === "string" ? { name: request } : request;
      const response = await appFetch(`/api/workspaces/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  // Initial fetch
  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

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
  };
}
