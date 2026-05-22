/**
 * Shared workspace settings form used by both the shell page and the legacy modal wrapper.
 */

import { useState, useEffect, type FormEvent } from "react";
import { Badge } from "../common";
import { ServerSettingsForm } from "../ServerSettingsForm";
import type { ServerSettings } from "../../types/settings";
import { createLogger } from "../../lib/logger";
import { AgentsMdSection } from "./agents-md-section";
import { PurgeTasksSection } from "./purge-tasks-section";
import { DeleteWorkspaceSection } from "./delete-workspace-section";
import type { WorkspaceSettingsFormProps } from "./types";

const log = createLogger("WorkspaceSettingsForm");

export function WorkspaceSettingsForm({
  workspace,
  status,
  onSave,
  onTest,
  onPurgeArchivedTasks,
  onDeleteWorkspace,
  purgeableTaskCount = 0,
  workspaceTaskCount = 0,
  saving = false,
  testing = false,
  purgingPurgeableTasks = false,
  remoteOnly = false,
  showConnectionStatus = true,
  formId = "workspace-settings-form",
  onSaved,
  onDeleted,
  onValidityChange,
}: WorkspaceSettingsFormProps) {
  const [name, setName] = useState("");
  const [serverSettings, setServerSettings] = useState<ServerSettings | null>(null);
  const [isServerSettingsValid, setIsServerSettingsValid] = useState(true);

  // Initialize form from workspace when the selected workspace changes
  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setServerSettings(workspace.serverSettings);
      setIsServerSettingsValid(true);
      return;
    }

    setName("");
    setServerSettings(null);
    setIsServerSettingsValid(true);
  }, [workspace]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!serverSettings) return;

    log.debug("Saving workspace settings", { workspaceName: name.trim() });
    const success = await onSave(name.trim(), serverSettings);
    if (success) {
      log.debug("Workspace settings saved successfully");
      onSaved?.();
    } else {
      log.warn("Failed to save workspace settings");
    }
  }

  function handleServerSettingsChange(settings: ServerSettings, isValid: boolean) {
    log.debug("Server settings changed", {
      provider: settings.agent.provider,
      transport: settings.agent.transport,
      isValid,
    });
    setServerSettings(settings);
    setIsServerSettingsValid(isValid);
  }

  const isNameValid = name.trim().length > 0;
  const isValid = isNameValid && isServerSettingsValid;

  useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  return (
    <>
      <form id={formId} onSubmit={handleSubmit} className="space-y-6">
        {/* Workspace Name */}
        <div>
          <label
            htmlFor={`${formId}-workspace-name`}
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Workspace Name
          </label>
          <input
            type="text"
            id={`${formId}-workspace-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Workspace"
            required
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>

        {/* Directory (read-only) */}
        {workspace && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Directory
            </label>
            <div className="w-full break-all rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-600 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-400">
              {workspace.directory}
            </div>
          </div>
        )}

        {showConnectionStatus && (
          <div className="flex items-center gap-2 rounded-md bg-gray-50 p-3 dark:bg-neutral-900">
            <span className="text-sm text-gray-600 dark:text-gray-400">Connection Status:</span>
            {status?.connected ? (
              <Badge variant="success">Connected</Badge>
            ) : status?.error ? (
              <Badge variant="error">Error</Badge>
            ) : (
              <Badge variant="warning">Idle</Badge>
            )}
            {status && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {status.provider}/{status.transport}
              </span>
            )}
          </div>
        )}

        {status?.error && (
          <div className="-mt-3 break-words text-xs text-red-600 dark:text-red-400">
            {status.error}
          </div>
        )}

        {/* Server Settings Form (shared component) */}
        {serverSettings && workspace && (
          <ServerSettingsForm
            initialSettings={workspace.serverSettings}
            onChange={handleServerSettingsChange}
            onTest={onTest}
            testing={testing}
            remoteOnly={remoteOnly}
          />
        )}

        {/* AGENTS.md Optimization */}
        {workspace && <AgentsMdSection workspace={workspace} />}
      </form>

      {/* Terminal-state task purge — rendered outside <form> so ConfirmModal buttons
          do not accidentally submit the form. */}
      {workspace && onPurgeArchivedTasks && (
        <PurgeTasksSection
          workspace={workspace}
          onPurgeArchivedTasks={onPurgeArchivedTasks}
          purgeableTaskCount={purgeableTaskCount}
          purgingPurgeableTasks={purgingPurgeableTasks}
        />
      )}

      {/* Delete Workspace — rendered outside <form> so ConfirmModal buttons
          do not accidentally submit the form. */}
      {workspace && onDeleteWorkspace && (
        <DeleteWorkspaceSection
          workspace={workspace}
          onDeleteWorkspace={onDeleteWorkspace}
          workspaceTaskCount={workspaceTaskCount}
          saving={saving}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
