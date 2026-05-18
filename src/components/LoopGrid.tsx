/**
 * Main content area for the Dashboard — renders loops grouped by workspace and status.
 * Supports both card grid and row list view modes.
 */

import type { DeleteWorkspaceRequest, Loop, SshServer } from "../types";
import type { StatusGroups, WorkspaceGroup } from "../hooks/useLoopGrouping";
import type { DashboardViewMode } from "../types/preferences";
import { WorkspaceHeader, StatusSections, UnassignedSection, EmptyWorkspacesSection } from "./loop-grid";

export interface LoopGridProps {
  loops: Loop[];
  loading: boolean;
  error: string | null;
  viewMode: DashboardViewMode;
  workspaceGroups: WorkspaceGroup[];
  registeredSshServers?: readonly SshServer[];
  unassignedLoops: Loop[];
  unassignedStatusGroups: StatusGroups;
  onSelectLoop?: (loopId: string) => void;
  onEditDraft: (loopId: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
}

export function LoopGrid({
  loops,
  loading,
  error,
  viewMode,
  workspaceGroups,
  registeredSshServers = [],
  unassignedLoops,
  unassignedStatusGroups,
  onSelectLoop,
  onEditDraft,
  onOpenWorkspaceSettings,
  onDeleteWorkspace,
}: LoopGridProps) {
  return (
    <div>
      {/* Error display */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 dark:bg-red-900/20 p-4">
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {/* Loading state */}
      {loading && loops.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
        </div>
      )}

      {/* Empty state - no loops at all */}
      {!loading && loops.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-400 dark:text-gray-500 mb-4">
            <svg
              className="mx-auto h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            No loops yet
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Click "New Loop" to create your first Ralph Loop.
          </p>
        </div>
      )}

      {/* Workspace-grouped loop sections */}
      {workspaceGroups.map(({ workspace, loops: workspaceLoops, statusGroups }) => {
        if (workspaceLoops.length === 0) return null;

        return (
          <div key={workspace.id} className="mb-10">
            <WorkspaceHeader
              workspace={workspace}
              loopCount={workspaceLoops.length}
              registeredSshServers={registeredSshServers}
              onOpenSettings={() => onOpenWorkspaceSettings(workspace.id)}
            />
            <div className="space-y-6 pl-2">
              <StatusSections
                statusGroups={statusGroups}
                keyPrefix={`workspace-${workspace.id}`}
                viewMode={viewMode}
                onEditDraft={onEditDraft}
                onSelectLoop={onSelectLoop}
              />
            </div>
          </div>
        );
      })}

      {/* Unassigned loops section */}
      <UnassignedSection
        unassignedLoops={unassignedLoops}
        unassignedStatusGroups={unassignedStatusGroups}
        viewMode={viewMode}
        onEditDraft={onEditDraft}
        onSelectLoop={onSelectLoop}
      />

      {/* Empty workspaces section */}
      <EmptyWorkspacesSection
        workspaceGroups={workspaceGroups}
        registeredSshServers={registeredSshServers}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onDeleteWorkspace={onDeleteWorkspace}
      />
    </div>
  );
}
