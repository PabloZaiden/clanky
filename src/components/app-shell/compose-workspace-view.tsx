import { useEffect, useRef } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { useDevboxTemplates } from "../../hooks/useDevboxTemplates";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { ServerSettingsForm } from "../ServerSettingsForm";
import type { ServerSettings } from "../../types/settings";
import type { AgentProvider } from "../../types/settings";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import { ShellPanel, InlineField } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { getProvisioningStatusBadgeVariant } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { SshServer } from "../../types/ssh-server";

interface ComposeWorkspaceViewProps {
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  servers: SshServer[];
  workspaceCreate: UseWorkspaceCreateResult;
  provisioning: UseProvisioningJobResult;
  workspacesSaving: boolean;
  dashboardData: Pick<UseDashboardDataResult, "remoteOnly">;
}

const COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID = "compose-workspace-automatic-advanced-options-panel";

export function ComposeWorkspaceView(props: ComposeWorkspaceViewProps) {
  const {
    shellHeaderOffsetClassName,
    navigateWithinShell,
    servers,
    workspaceCreate,
    provisioning,
    workspacesSaving,
    dashboardData,
  } = props;

  const {
    workspaceCreateMode,
    setWorkspaceCreateMode,
    workspaceName,
    setWorkspaceName,
    workspaceDirectory,
    setWorkspaceDirectory,
    workspaceServerSettings,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticServerId,
    setAutomaticServerId,
    automaticRepoUrl,
    setAutomaticRepoUrl,
    automaticCreateNewRepository,
    setAutomaticCreateNewRepository,
    automaticBasePath,
    setAutomaticBasePath,
    automaticDevcontainerSubpath,
    setAutomaticDevcontainerSubpath,
    automaticDevboxTemplate,
    setAutomaticDevboxTemplate,
    automaticAdvancedOpen,
    setAutomaticAdvancedOpen,
    automaticProvider,
    setAutomaticProvider,
    automaticPassword,
    setAutomaticPassword,
    handleCreateWorkspace,
    handleTestWorkspaceConnection,
    handleBackToAutomaticWorkspaceForm,
  } = workspaceCreate;
  const autoSelectedDevboxTemplateRef = useRef<string | null>(null);

  const workspaceCreateFormId = "workspace-create-form";
  const provisioningStatus = provisioning.snapshot?.job.state.status;
  const provisionedWorkspaceId =
    provisioning.snapshot?.workspace?.id ?? provisioning.snapshot?.job.state.workspaceId;
  const canReturnToAutomaticForm =
    provisioningStatus === "failed" || provisioningStatus === "cancelled";
  const selectedServerHasStoredCredential = automaticServerId
    ? getStoredSshServerCredential(automaticServerId) !== null
    : false;
  const {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  } = useDevboxTemplates({
    serverId: automaticServerId,
    password: automaticPassword,
  });
  useEffect(() => {
    if (!automaticCreateNewRepository || automaticDevboxTemplate || templatesLoading) {
      return;
    }
    const firstTemplate = templates[0]?.name;
    if (firstTemplate) {
      autoSelectedDevboxTemplateRef.current = firstTemplate;
      setAutomaticDevboxTemplate(firstTemplate);
    }
  }, [automaticCreateNewRepository, automaticDevboxTemplate, setAutomaticDevboxTemplate, templates, templatesLoading]);
  const automaticFormValid =
    workspaceName.trim().length > 0 &&
    automaticServerId.trim().length > 0 &&
    (automaticCreateNewRepository || automaticRepoUrl.trim().length > 0) &&
    automaticBasePath.trim().length > 0 &&
    (!automaticCreateNewRepository || automaticDevboxTemplate.trim().length > 0);
  const manualFormValid =
    workspaceName.trim().length > 0 &&
    workspaceDirectory.trim().length > 0 &&
    workspaceServerSettingsValid;
  const createActionLabel =
    workspaceCreateMode === "automatic" ? "Start Provisioning" : "Create Workspace";
  const createActionLoading =
    workspaceCreateMode === "automatic"
      ? provisioning.starting
      : workspaceCreateSubmitting || workspacesSaving;
  const createActionDisabled =
    workspaceCreateMode === "automatic" ? !automaticFormValid : !manualFormValid;
  const advancedSummary = automaticDevboxTemplate
    ? `Template: ${automaticDevboxTemplate}`
    : automaticDevcontainerSubpath
      ? "Devcontainer variant configured"
      : "Optional template and repo devcontainer overrides";

  const createModeControls = (
    <>
      <Button
        type="button"
        size="sm"
        variant={workspaceCreateMode === "manual" ? "primary" : "secondary"}
        onClick={() => setWorkspaceCreateMode("manual")}
      >
        Manual
      </Button>
      <Button
        type="button"
        size="sm"
        variant={workspaceCreateMode === "automatic" ? "primary" : "secondary"}
        onClick={() => setWorkspaceCreateMode("automatic")}
      >
        Automatic
      </Button>
    </>
  );

  const createHeaderAction = (
    <Button
      type="submit"
      form={workspaceCreateFormId}
      size="sm"
      loading={createActionLoading}
      disabled={createActionDisabled}
    >
      {createActionLabel}
    </Button>
  );

  const provisioningActions = (
    <>
      {canReturnToAutomaticForm && (
        <Button type="button" size="sm" onClick={handleBackToAutomaticWorkspaceForm}>
          Back to Automatic Form
        </Button>
      )}
      {provisionedWorkspaceId && provisioningStatus === "completed" && (
        <Button
          type="button"
          size="sm"
          onClick={() =>
            navigateWithinShell({ view: "workspace", workspaceId: provisionedWorkspaceId })
          }
        >
          Open Workspace
        </Button>
      )}
      {(provisioningStatus === "running" || provisioningStatus === "pending") && (
        <Button
          type="button"
          size="sm"
          variant="danger"
          onClick={() => {
            void provisioning.cancelJob();
          }}
        >
          Cancel Job
        </Button>
      )}
    </>
  );

  return (
    <ShellPanel
      eyebrow="Workspace"
      title="Create a workspace"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      badges={
        provisioningStatus ? (
          <Badge variant={getProvisioningStatusBadgeVariant(provisioningStatus)} size="sm">
            {provisioningStatus}
          </Badge>
        ) : undefined
      }
      actions={!provisioning.activeJobId ? createHeaderAction : undefined}
    >
      {provisioning.activeJobId ? (
        <div className="space-y-6">
          <div className="flex flex-wrap justify-end gap-2">
            {provisioningActions}
          </div>
          <ProvisioningJobView
            snapshot={provisioning.snapshot}
            logs={provisioning.logs}
            websocketStatus={provisioning.websocketStatus}
            loading={provisioning.loading}
            error={provisioning.error}
          />
        </div>
      ) : (
        <form
          id={workspaceCreateFormId}
          className="space-y-6"
          onSubmit={(event) => handleCreateWorkspace(event)}
        >
          <div className="flex flex-wrap gap-2">
            {createModeControls}
          </div>

          <InlineField
            id="workspace-name"
            label="Workspace name"
            value={workspaceName}
            onChange={setWorkspaceName}
            placeholder="Main repository"
            required
          />

          {workspaceCreateMode === "manual" ? (
            <>
              <InlineField
                id="workspace-directory"
                label="Directory"
                value={workspaceDirectory}
                onChange={setWorkspaceDirectory}
                placeholder="/workspaces/project"
                required
                help="Absolute path on the selected workspace host."
              />
              <ServerSettingsForm
                initialSettings={workspaceServerSettings}
                onChange={(settings: ServerSettings, isValid: boolean) => {
                  setWorkspaceServerSettings((current: ServerSettings) => {
                    return JSON.stringify(current) === JSON.stringify(settings) ? current : settings;
                  });
                  setWorkspaceServerSettingsValid(isValid);
                }}
                onTest={handleTestWorkspaceConnection}
                testing={workspaceTesting}
                remoteOnly={dashboardData.remoteOnly}
                registeredSshServers={servers}
              />
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="automatic-ssh-server"
                  className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Saved SSH server <span className="ml-1 text-red-500">*</span>
                </label>
                <select
                  id="automatic-ssh-server"
                  value={automaticServerId}
                  onChange={(event) => {
                    const newServerId = event.target.value;
                    setAutomaticServerId(newServerId);
                    setAutomaticDevboxTemplate("");
                    const selectedServer = servers.find((s) => s.config.id === newServerId);
                    if (selectedServer?.config.repositoriesBasePath) {
                      setAutomaticBasePath(selectedServer.config.repositoriesBasePath);
                    }
                  }}
                  className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
                >
                  <option value="">Select a saved SSH server</option>
                  {servers.map((server) => (
                    <option key={server.config.id} value={server.config.id}>
                      {server.config.name} ({server.config.username}@{server.config.address})
                    </option>
                  ))}
                </select>
                {servers.length === 0 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Register a saved SSH server first to use automatic workspace provisioning.
                  </p>
                )}
              </div>

              <InlineField
                id="automatic-repo-url"
                label="Git repository URL"
                value={automaticRepoUrl}
                onChange={setAutomaticRepoUrl}
                placeholder="git@github.com:owner/repo.git"
                required={!automaticCreateNewRepository}
                disabled={automaticCreateNewRepository}
                help={automaticCreateNewRepository ? "Disabled because this workspace will start from a new local git repository." : "Repository to clone on the remote host."}
              />
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={automaticCreateNewRepository}
                  onChange={(event) => {
                    const createNewRepository = event.target.checked;
                    setAutomaticCreateNewRepository(createNewRepository);
                    if (
                      !createNewRepository
                      && autoSelectedDevboxTemplateRef.current
                      && automaticDevboxTemplate === autoSelectedDevboxTemplateRef.current
                    ) {
                      setAutomaticDevboxTemplate("");
                    }
                    autoSelectedDevboxTemplateRef.current = null;
                  }}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span>Create a new repository (the repository doesn't exist yet)</span>
              </label>

              <InlineField
                id="automatic-base-path"
                label="Remote base path"
                value={automaticBasePath}
                onChange={setAutomaticBasePath}
                placeholder="/workspaces"
                required
                help="Parent directory where the repo should be cloned."
              />

              <div>
                <label
                  htmlFor="automatic-provider"
                  className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Provider <span className="ml-1 text-red-500">*</span>
                </label>
                <select
                  id="automatic-provider"
                  value={automaticProvider}
                  onChange={(event) =>
                    setAutomaticProvider(event.target.value as AgentProvider)
                  }
                  className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
                >
                  {AGENT_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </div>

              {!selectedServerHasStoredCredential && (
                <InlineField
                  id="automatic-ssh-password"
                  label="SSH password"
                  value={automaticPassword}
                  onChange={setAutomaticPassword}
                  placeholder="Leave blank for key-based auth"
                  type="password"
                  help="Stored encrypted in this client to start provisioning when password auth is required."
                  inputProps={PASSWORD_INPUT_PROPS}
                />
              )}

              <div className="rounded-2xl border border-gray-200 bg-white/70 dark:border-gray-800 dark:bg-neutral-900/70">
                <button
                  type="button"
                  onClick={() => setAutomaticAdvancedOpen(!automaticAdvancedOpen)}
                  aria-expanded={automaticAdvancedOpen}
                  aria-controls={COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Advanced options</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{advancedSummary}</p>
                  </div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {automaticAdvancedOpen ? "Hide" : "Show"}
                  </span>
                </button>

                {automaticAdvancedOpen && (
                  <div
                    id={COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID}
                    className="space-y-4 border-t border-gray-200 px-4 py-4 dark:border-gray-800"
                  >
                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <label
                          htmlFor="automatic-devbox-template"
                          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                        >
                          Devbox template
                        </label>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => { void refreshTemplates(automaticPassword); }}
                        >
                          Refresh templates
                        </Button>
                      </div>
                      <select
                        id="automatic-devbox-template"
                        value={automaticDevboxTemplate}
                        onChange={(event) => {
                          autoSelectedDevboxTemplateRef.current = null;
                          setAutomaticDevboxTemplate(event.target.value);
                        }}
                        disabled={!automaticServerId || templatesLoading}
                        className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 disabled:cursor-not-allowed disabled:bg-gray-100 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700 dark:disabled:bg-neutral-900"
                      >
                        {!automaticCreateNewRepository && (
                          <option value="">Use repository devcontainer (default)</option>
                        )}
                        {templatesLoading && <option value="" disabled>Loading templates...</option>}
                        {!templatesLoading && templates.map((template) => (
                          <option key={template.name} value={template.name}>
                            {template.name} - {template.runtimeVersion}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                        {automaticCreateNewRepository
                          ? "Required because there is no repository devcontainer yet."
                          : "Optional. Choose a built-in devbox template instead of the repository devcontainer definition for this provisioning run."}
                      </p>
                      {templatesError && (
                        <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">{templatesError}</p>
                      )}
                    </div>

                    <InlineField
                      id="automatic-devcontainer-subpath"
                      label="Devcontainer variant"
                      value={automaticDevcontainerSubpath}
                      onChange={setAutomaticDevcontainerSubpath}
                      placeholder="backend"
                      disabled={automaticDevboxTemplate.length > 0}
                      help={automaticDevboxTemplate
                        ? "Disabled while a devbox template is selected. Clear the template to use the repository devcontainer definition instead."
                        : "Optional. Use when the repository contains multiple devcontainer definitions and devbox needs a specific one."}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {provisioning.error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
              <p className="text-sm text-red-600 dark:text-red-400">{provisioning.error}</p>
            </div>
          )}
        </form>
      )}
    </ShellPanel>
  );
}
