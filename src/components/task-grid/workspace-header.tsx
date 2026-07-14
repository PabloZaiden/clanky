import type { Workspace, SshServer } from "@/shared";
import { getServerLabel } from "@/shared/settings";
import { WorkspaceGearIcon } from "./workspace-gear-icon";

/** Workspace header with icon, name, settings button, path, and task count */
export function WorkspaceHeader({
  workspace,
  taskCount,
  registeredSshServers,
  onOpenSettings,
  privateHidden = false,
}: {
  workspace: Workspace;
  taskCount: number;
  registeredSshServers: readonly SshServer[];
  onOpenSettings: () => void;
  privateHidden?: boolean;
}) {
  return (
    <div className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-4 pb-2 border-b border-gray-200 dark:border-gray-700 ${privateHidden ? "clanky-private-obscured" : ""}`}>
      <div className="flex min-w-0 items-start gap-2">
        <svg className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <h2 className="break-words text-xl font-bold text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
          {workspace.name}
        </h2>
        <button
          type="button"
          onClick={onOpenSettings}
          className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
          title="Workspace Settings"
        >
          <WorkspaceGearIcon />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-1">
        <span className="min-w-0 break-words text-sm text-gray-500 dark:text-gray-400 [overflow-wrap:anywhere]" title={workspace.directory}>
          {workspace.directory}
        </span>
        <span
          className="min-w-0 break-words text-xs text-gray-400 dark:text-gray-500 [overflow-wrap:anywhere]"
          title={getServerLabel(workspace.serverSettings, registeredSshServers)}
        >
          {getServerLabel(workspace.serverSettings, registeredSshServers)}
        </span>
        <span className="text-sm text-gray-400 dark:text-gray-500 flex-shrink-0 whitespace-nowrap">
          ({taskCount} {taskCount === 1 ? "task" : "tasks"})
        </span>
      </div>
    </div>
  );
}
