/**
 * Form fields for automatic workspace provisioning over SSH.
 */

import { PASSWORD_INPUT_PROPS } from "../common";
import type { AgentProvider, DevboxTemplateSummary, SshServer } from "../../types";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";

interface AutomaticWorkspaceFormProps {
  serverId: string;
  onServerIdChange: (id: string) => void;
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  createNewRepository: boolean;
  onCreateNewRepositoryChange: (createNewRepository: boolean) => void;
  basePath: string;
  onBasePathChange: (path: string) => void;
  devcontainerSubpath: string;
  onDevcontainerSubpathChange: (subpath: string) => void;
  devboxTemplate: string;
  onDevboxTemplateChange: (template: string) => void;
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  password: string;
  onPasswordChange: (password: string) => void;
  registeredSshServers: SshServer[];
  selectedServerHasStoredCredential: boolean;
  templates: DevboxTemplateSummary[];
  templatesLoading: boolean;
  templatesError: string | null;
  onRetryTemplates: () => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
}

const AUTOMATIC_ADVANCED_PANEL_ID = "create-workspace-automatic-advanced-options-panel";

export function AutomaticWorkspaceForm({
  serverId,
  onServerIdChange,
  repoUrl,
  onRepoUrlChange,
  createNewRepository,
  onCreateNewRepositoryChange,
  basePath,
  onBasePathChange,
  devcontainerSubpath,
  onDevcontainerSubpathChange,
  devboxTemplate,
  onDevboxTemplateChange,
  provider,
  onProviderChange,
  password,
  onPasswordChange,
  registeredSshServers,
  selectedServerHasStoredCredential,
  templates,
  templatesLoading,
  templatesError,
  onRetryTemplates,
  advancedOpen,
  onAdvancedOpenChange,
}: AutomaticWorkspaceFormProps) {
  const advancedSummary = devboxTemplate
    ? `Template: ${devboxTemplate}`
    : devcontainerSubpath
      ? "Devcontainer variant configured"
      : "Optional template and repo devcontainer overrides";

  return (
    <>
      <div>
        <label
          htmlFor="automatic-ssh-server"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Saved SSH Server <span className="text-red-500">*</span>
        </label>
        <select
          id="automatic-ssh-server"
          value={serverId}
          onChange={(e) => onServerIdChange(e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
        >
          <option value="">Select a saved SSH server</option>
          {registeredSshServers.map((server) => (
            <option key={server.config.id} value={server.config.id}>
              {server.config.name} ({server.config.username}@{server.config.address})
            </option>
          ))}
        </select>
        {registeredSshServers.length === 0 && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Add a saved SSH server first to use automatic workspace provisioning.
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="automatic-repo-url"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Git Repository URL <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          id="automatic-repo-url"
          value={repoUrl}
          onChange={(e) => onRepoUrlChange(e.target.value)}
          placeholder="git@github.com:owner/repo.git"
          required={!createNewRepository}
          disabled={createNewRepository}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:disabled:bg-neutral-900 font-mono"
        />
        <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={createNewRepository}
            onChange={(e) => onCreateNewRepositoryChange(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span>Create a new repository (the repository doesn't exist yet)</span>
        </label>
      </div>

      <div>
        <label
          htmlFor="automatic-base-path"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Remote Base Path <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          id="automatic-base-path"
          value={basePath}
          onChange={(e) => onBasePathChange(e.target.value)}
          placeholder="/workspaces"
          required
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 font-mono"
        />
      </div>

      <div>
        <label
          htmlFor="automatic-provider"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Provider <span className="text-red-500">*</span>
        </label>
        <select
          id="automatic-provider"
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AgentProvider)}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
        >
          {AGENT_PROVIDER_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </div>

      {!selectedServerHasStoredCredential && (
        <div>
          <label
            htmlFor="automatic-ssh-password"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            SSH Password
          </label>
          <input
            {...PASSWORD_INPUT_PROPS}
            type="password"
            id="automatic-ssh-password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Leave blank for key-based auth"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            The password is encrypted in the browser, exchanged for a short-lived token, and kept in memory only while provisioning runs.
          </p>
        </div>
      )}

      <div className="rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-neutral-800">
        <button
          type="button"
          onClick={() => onAdvancedOpenChange(!advancedOpen)}
          aria-expanded={advancedOpen}
          aria-controls={AUTOMATIC_ADVANCED_PANEL_ID}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        >
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Advanced options</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{advancedSummary}</p>
          </div>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {advancedOpen ? "Hide" : "Show"}
          </span>
        </button>

        {advancedOpen && (
          <div
            id={AUTOMATIC_ADVANCED_PANEL_ID}
            className="space-y-4 border-t border-gray-300 px-3 py-3 dark:border-gray-600"
          >
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label
                  htmlFor="automatic-devbox-template"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Devbox Template
                </label>
                <button
                  type="button"
                  onClick={onRetryTemplates}
                  className="text-xs font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  Refresh templates
                </button>
              </div>
              <select
                id="automatic-devbox-template"
                value={devboxTemplate}
                onChange={(e) => onDevboxTemplateChange(e.target.value)}
                disabled={!serverId || templatesLoading}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:disabled:bg-neutral-900"
              >
                {!createNewRepository && <option value="">Use repository devcontainer (default)</option>}
                {templatesLoading && <option value="" disabled>Loading templates...</option>}
                {!templatesLoading && templates.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.name} - {template.runtimeVersion}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {createNewRepository
                  ? "Required because there is no repository devcontainer yet."
                  : "Optional. Choose a built-in devbox template instead of the repository devcontainer definition for this provisioning run."}
              </p>
              {templatesError && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{templatesError}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="automatic-devcontainer-subpath"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Devcontainer Variant
              </label>
              <input
                type="text"
                id="automatic-devcontainer-subpath"
                value={devcontainerSubpath}
                onChange={(e) => onDevcontainerSubpathChange(e.target.value)}
                placeholder="backend"
                disabled={devboxTemplate.length > 0}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:disabled:bg-neutral-900 font-mono"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {devboxTemplate
                  ? "Disabled while a devbox template is selected. Clear the template to use the repository devcontainer definition instead."
                  : "Optional. Only set this when the repository exposes multiple devcontainer definitions and devbox needs a specific one."}
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
