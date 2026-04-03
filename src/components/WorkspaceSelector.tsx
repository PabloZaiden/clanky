/**
 * WorkspaceSelector component for selecting existing workspaces.
 * 
 * Provides a dropdown to select an existing workspace.
 * Workspace creation should be done from the Dashboard, not from within loop creation.
 */

import type { ChangeEvent } from "react";
import type { SshServer } from "../types";
import type { Workspace } from "../types/workspace";
import { getServerLabel } from "../types/settings";

export interface WorkspaceSelectorProps {
  /** List of available workspaces */
  workspaces: Workspace[];
  /** Whether workspaces are loading */
  loading?: boolean;
  /** Currently selected workspace ID */
  selectedWorkspaceId?: string;
  /** Callback when workspace selection changes */
  onSelect: (workspaceId: string | null, directory: string) => void;
  /** Error message from workspace operations */
  error?: string | null;
  /** Registered SSH servers for friendly label resolution */
  registeredSshServers?: readonly SshServer[];
  /** Whether to append server details to each workspace label */
  showServerDetails?: boolean;
}

export function WorkspaceSelector({
  workspaces,
  loading = false,
  selectedWorkspaceId,
  onSelect,
  error,
  registeredSshServers = [],
  showServerDetails = true,
}: WorkspaceSelectorProps) {
  // Handle workspace selection from dropdown
  function handleWorkspaceChange(e: ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    
    if (value === "") {
      onSelect(null, "");
      return;
    }
    
    const workspace = workspaces.find((w) => w.id === value);
    if (workspace) {
      onSelect(workspace.id, workspace.directory);
    }
  }

  const hasNoWorkspaces = !loading && workspaces.length === 0;

  return (
    <div>
      <label
        htmlFor="workspace"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Workspace <span className="text-red-500">*</span>
      </label>
      <select
        id="workspace"
        value={selectedWorkspaceId || ""}
        onChange={handleWorkspaceChange}
        disabled={loading || hasNoWorkspaces}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 text-sm disabled:opacity-50"
      >
        <option value="">
          {loading 
            ? "Loading workspaces..." 
            : hasNoWorkspaces 
              ? "No workspaces available" 
              : "Select a workspace..."}
        </option>
        
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {showServerDetails
              ? `${workspace.name} — ${getServerLabel(workspace.serverSettings, registeredSshServers)}`
              : workspace.name}
          </option>
        ))}
      </select>
      
      {hasNoWorkspaces && (
        <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
          Create a workspace from the dashboard first.
        </p>
      )}
      
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
