/**
 * Main content area for the Dashboard — renders tasks grouped by workspace and status.
 * Supports both card grid and row list view modes.
 */

import type { Task, SshServer } from "@/shared";
import type { DeleteWorkspaceRequest } from "@/contracts/schemas/workspace";
import type { StatusGroups, WorkspaceGroup } from "../hooks/useTaskGrouping";
import type { DashboardViewMode } from "@/shared/preferences";
import { WorkspaceHeader, StatusSections, UnassignedSection, EmptyWorkspacesSection } from "./task-grid";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../lib/private-items";

export interface TaskGridProps {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  viewMode: DashboardViewMode;
  workspaceGroups: WorkspaceGroup[];
  registeredSshServers?: readonly SshServer[];
  unassignedTasks: Task[];
  unassignedStatusGroups: StatusGroups;
  onSelectTask?: (taskId: string) => void;
  onEditDraft: (taskId: string) => void;
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string, options?: DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  showPrivateItems?: boolean;
}

export function TaskGrid({
  tasks,
  loading,
  error,
  viewMode,
  workspaceGroups,
  registeredSshServers = [],
  unassignedTasks,
  unassignedStatusGroups,
  onSelectTask,
  onEditDraft,
  onOpenWorkspaceSettings,
  onDeleteWorkspace,
  showPrivateItems = false,
}: TaskGridProps) {
  return (
    <div>
      {/* Error display */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 dark:bg-red-900/20 p-4">
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {/* Loading state */}
      {loading && tasks.length === 0 && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
        </div>
      )}

      {/* Empty state - no tasks at all */}
      {!loading && tasks.length === 0 && (
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
            No tasks yet
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Click "New Task" to create your first Clanky Task.
          </p>
        </div>
      )}

      {/* Workspace-grouped task sections */}
      {workspaceGroups.map(({ workspace, tasks: workspaceTasks, statusGroups }) => {
        if (workspaceTasks.length === 0) return null;
        const workspacePrivateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(workspace), showPrivateItems);

        return (
          <div key={workspace.id} className="mb-10">
            <WorkspaceHeader
              workspace={workspace}
              taskCount={workspaceTasks.length}
              registeredSshServers={registeredSshServers}
              onOpenSettings={() => {
                if (!workspacePrivateHidden) {
                  onOpenWorkspaceSettings(workspace.id);
                }
              }}
              privateHidden={workspacePrivateHidden}
            />
            <div className="space-y-6 pl-2">
              <StatusSections
                statusGroups={statusGroups}
                keyPrefix={`workspace-${workspace.id}`}
                viewMode={viewMode}
                onEditDraft={onEditDraft}
                onSelectTask={onSelectTask}
                isTaskPrivateHidden={(task) => shouldObscurePrivateItem(
                  isEffectivelyPrivate(task.config, [workspace]),
                  showPrivateItems,
                )}
              />
            </div>
          </div>
        );
      })}

      {/* Unassigned tasks section */}
      <UnassignedSection
        unassignedTasks={unassignedTasks}
        unassignedStatusGroups={unassignedStatusGroups}
        viewMode={viewMode}
        onEditDraft={onEditDraft}
        onSelectTask={onSelectTask}
      />

      {/* Empty workspaces section */}
      <EmptyWorkspacesSection
        workspaceGroups={workspaceGroups}
        registeredSshServers={registeredSshServers}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onDeleteWorkspace={onDeleteWorkspace}
        showPrivateItems={showPrivateItems}
      />
    </div>
  );
}
