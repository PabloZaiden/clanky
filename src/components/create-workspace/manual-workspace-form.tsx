/**
 * Form fields for manual workspace creation (directory + server settings).
 */

import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings, SshServer, WorkspaceType } from "@/shared";

interface ManualWorkspaceFormProps {
  directory: string;
  onDirectoryChange: (value: string) => void;
  workspaceType: WorkspaceType;
  onWorkspaceTypeChange: (value: WorkspaceType) => void;
  defaultServerSettings: ServerSettings;
  executionNodeId: string | null;
  onServerSettingsChange: (settings: ServerSettings, isValid: boolean, executionNodeId: string | null) => void;
  onTestConnection: (settings: ServerSettings, executionNodeId: string | null) => Promise<{ success: boolean; error?: string }>;
  testing: boolean;
  remoteOnly: boolean;
  registeredSshServers: SshServer[];
}

export function ManualWorkspaceForm({
  directory,
  onDirectoryChange,
  workspaceType,
  onWorkspaceTypeChange,
  defaultServerSettings,
  executionNodeId,
  onServerSettingsChange,
  onTestConnection,
  testing,
  remoteOnly,
  registeredSshServers,
}: ManualWorkspaceFormProps) {
  return (
    <>
      <div>
        <label
          htmlFor="workspace-directory"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Directory <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          id="workspace-directory"
          value={directory}
          onChange={(e) => onDirectoryChange(e.target.value)}
          placeholder="/path/to/project"
          required
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 font-mono"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The directory must already exist on the selected workspace host.
        </p>
      </div>

      <div>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={workspaceType === "git"}
            onChange={(event) => onWorkspaceTypeChange(event.target.checked ? "git" : "directory")}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Git-backed workspace
            </span>
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
              Required for tasks, branches, worktrees, GitHub, and Git maintenance. Uncheck to run chats and agents directly in this directory.
            </span>
          </span>
        </label>
      </div>

      <ServerSettingsForm
        initialSettings={defaultServerSettings}
        initialExecutionNodeId={executionNodeId}
        onChange={onServerSettingsChange}
        onTest={onTestConnection}
        testing={testing}
        remoteOnly={remoteOnly}
        registeredSshServers={registeredSshServers}
      />
    </>
  );
}
