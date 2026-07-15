/**
 * Form fields for manual workspace creation (directory + server settings).
 */

import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings, SshServer } from "@/shared";

interface ManualWorkspaceFormProps {
  directory: string;
  onDirectoryChange: (value: string) => void;
  defaultServerSettings: ServerSettings;
  onServerSettingsChange: (settings: ServerSettings, isValid: boolean) => void;
  onTestConnection: (settings: ServerSettings) => Promise<{ success: boolean; error?: string }>;
  testing: boolean;
  remoteOnly: boolean;
  registeredSshServers: SshServer[];
}

export function ManualWorkspaceForm({
  directory,
  onDirectoryChange,
  defaultServerSettings,
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
          Must be a git repository.
        </p>
      </div>

      <ServerSettingsForm
        initialSettings={defaultServerSettings}
        onChange={onServerSettingsChange}
        onTest={onTestConnection}
        testing={testing}
        remoteOnly={remoteOnly}
        registeredSshServers={registeredSshServers}
      />
    </>
  );
}
