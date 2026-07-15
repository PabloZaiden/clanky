import { useEffect, useMemo, useRef } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { useDevboxTemplates } from "../../hooks/useDevboxTemplates";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings } from "@/shared/settings";
import type { AgentProvider } from "@/shared/settings";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import {
  ErrorState,
  FormGroup,
  SelectField,
  TextField,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { getProvisioningStatusBadgeVariant } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { SshServer } from "@/shared/ssh-server";
import {
  getAutomaticWorkspaceBasePath,
  saveLastAutomaticWorkspaceSshServerId,
} from "../../lib/automatic-workspace-preferences";
import { useShellHeaderActions } from "./shell-header-actions";

interface ComposeWorkspaceViewProps {
  navigateWithinShell: (route: WebAppRoute) => void;
  servers: SshServer[];
  workspaceCreate: UseWorkspaceCreateResult;
  provisioning: UseProvisioningJobResult;
  workspacesSaving: boolean;
  dashboardData: Pick<UseDashboardDataResult, "remoteOnly">;
}

const COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID = "compose-workspace-automatic-advanced-options-panel";

export function ComposeWorkspaceView(props: ComposeWorkspaceViewProps) {
  const {
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
    automaticGithubUser,
    setAutomaticGithubUser,
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
  const trimmedAutomaticDevboxTemplate = automaticDevboxTemplate.trim();
  const trimmedAutomaticDevcontainerSubpath = automaticDevcontainerSubpath.trim();
  const trimmedAutomaticGithubUser = automaticGithubUser.trim();
  const advancedSummaryItems = [
    trimmedAutomaticDevboxTemplate ? `Template: ${trimmedAutomaticDevboxTemplate}` : null,
    !trimmedAutomaticDevboxTemplate && trimmedAutomaticDevcontainerSubpath ? "Devcontainer variant configured" : null,
    trimmedAutomaticGithubUser ? `GitHub account: ${trimmedAutomaticGithubUser}` : null,
  ].filter((item): item is string => item !== null);
  const advancedSummary = advancedSummaryItems.length > 0
    ? advancedSummaryItems.join(" · ")
    : "Optional template, repo devcontainer, and GitHub account overrides";

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

  const headerActions = useMemo(() => (
    <>
      {provisioningStatus ? (
        <Badge variant={getProvisioningStatusBadgeVariant(provisioningStatus)} size="sm">
          {provisioningStatus}
        </Badge>
      ) : null}
      {provisioning.activeJobId ? (
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
              onClick={() => navigateWithinShell({ view: "workspace", workspaceId: provisionedWorkspaceId })}
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
      ) : (
        <Button
          type="submit"
          form={workspaceCreateFormId}
          size="sm"
          loading={createActionLoading}
          disabled={createActionDisabled}
        >
          {createActionLabel}
        </Button>
      )}
    </>
  ), [
    canReturnToAutomaticForm,
    createActionDisabled,
    createActionLabel,
    createActionLoading,
    handleBackToAutomaticWorkspaceForm,
    navigateWithinShell,
    provisionedWorkspaceId,
    provisioning.activeJobId,
    provisioning.cancelJob,
    provisioningStatus,
    workspaceCreateFormId,
  ]);
  useShellHeaderActions(headerActions);

  return (
    <div className="space-y-6">
      {provisioning.activeJobId ? (
        <div className="space-y-6">
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

          <FormGroup title="Workspace details">
          <TextField
            id="workspace-name"
            label="Workspace name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="Main repository"
            required
          />

          {workspaceCreateMode === "manual" ? (
            <>
              <TextField
                id="workspace-directory"
                label="Directory"
                value={workspaceDirectory}
                onChange={(event) => setWorkspaceDirectory(event.target.value)}
                placeholder="/workspaces/project"
                required
                hint="Absolute path on the selected workspace host."
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
              <SelectField
                  id="automatic-ssh-server"
                  label="Saved SSH server"
                  value={automaticServerId}
                  onChange={(event) => {
                    const newServerId = event.target.value;
                    setAutomaticServerId(newServerId);
                    saveLastAutomaticWorkspaceSshServerId(newServerId);
                    setAutomaticDevboxTemplate("");
                    const selectedServer = servers.find((s) => s.config.id === newServerId);
                    setAutomaticBasePath(getAutomaticWorkspaceBasePath(selectedServer ?? null));
                  }}
              >
                  <option value="">Select a saved SSH server</option>
                  {servers.map((server) => (
                    <option key={server.config.id} value={server.config.id}>
                      {server.config.name} ({server.config.username}@{server.config.address})
                    </option>
                  ))}
              </SelectField>
                {servers.length === 0 && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Register a saved SSH server first to use automatic workspace provisioning.
                  </p>
                )}

              <TextField
                id="automatic-repo-url"
                label="Git repository URL"
                value={automaticRepoUrl}
                onChange={(event) => setAutomaticRepoUrl(event.target.value)}
                placeholder="git@github.com:owner/repo.git"
                required={!automaticCreateNewRepository}
                disabled={automaticCreateNewRepository}
                hint={automaticCreateNewRepository ? "Disabled because this workspace will start from a new local git repository." : "Repository to clone on the remote host."}
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

              <TextField
                id="automatic-base-path"
                label="Remote base path"
                value={automaticBasePath}
                onChange={(event) => setAutomaticBasePath(event.target.value)}
                placeholder="/workspaces"
                required
                hint="Parent directory where the repo should be cloned."
              />

              <SelectField
                  id="automatic-provider"
                  label="Provider"
                  value={automaticProvider}
                  onChange={(event) =>
                    setAutomaticProvider(event.target.value as AgentProvider)
                  }
              >
                  {AGENT_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
              </SelectField>

              {!selectedServerHasStoredCredential && (
                <TextField
                  id="automatic-ssh-password"
                  label="SSH password"
                  value={automaticPassword}
                  onChange={(event) => setAutomaticPassword(event.target.value)}
                  placeholder="Leave blank for key-based auth"
                  type="password"
                  hint="Stored encrypted in this client to start provisioning when password auth is required."
                  {...PASSWORD_INPUT_PROPS}
                />
              )}

              <FormGroup
                title="Advanced options"
                description={advancedSummary}
                actions={(
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setAutomaticAdvancedOpen(!automaticAdvancedOpen)}
                    aria-expanded={automaticAdvancedOpen}
                    aria-controls={COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID}
                  >
                    {automaticAdvancedOpen ? "Hide" : "Show"}
                  </Button>
                )}
              >
                {automaticAdvancedOpen && (
                  <div id={COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID} className="space-y-4">
                    <FormGroup
                      title="Devbox template"
                      actions={(
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => { void refreshTemplates(automaticPassword); }}
                        >
                          Refresh templates
                        </Button>
                      )}
                    >
                      <SelectField
                        id="automatic-devbox-template"
                        label="Template"
                        value={automaticDevboxTemplate}
                        onChange={(event) => {
                          autoSelectedDevboxTemplateRef.current = null;
                          setAutomaticDevboxTemplate(event.target.value);
                        }}
                        disabled={!automaticServerId || templatesLoading}
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
                      </SelectField>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {automaticCreateNewRepository
                          ? "Required because there is no repository devcontainer yet."
                          : "Optional. Choose a built-in devbox template instead of the repository devcontainer definition for this provisioning run."}
                      </p>
                      {templatesError && (
                        <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">{templatesError}</p>
                      )}
                    </FormGroup>

                    <TextField
                      id="automatic-github-user"
                      label="GitHub CLI account"
                      value={automaticGithubUser}
                      onChange={(event) => setAutomaticGithubUser(event.target.value)}
                      placeholder="work-account"
                      hint="Optional. When set, devbox runs with --gh-user for GH_TOKEN injection. Leave blank to use the current default gh account."
                    />

                    <TextField
                      id="automatic-devcontainer-subpath"
                      label="Devcontainer variant"
                      value={automaticDevcontainerSubpath}
                      onChange={(event) => setAutomaticDevcontainerSubpath(event.target.value)}
                      placeholder="backend"
                      disabled={automaticDevboxTemplate.length > 0}
                      hint={automaticDevboxTemplate
                        ? "Disabled while a devbox template is selected. Clear the template to use the repository devcontainer definition instead."
                        : "Optional. Use when the repository contains multiple devcontainer definitions and devbox needs a specific one."}
                    />
                  </div>
                )}
              </FormGroup>
            </div>
          )}
          </FormGroup>

          {provisioning.error && (
            <ErrorState title="Unable to provision workspace" description={provisioning.error} />
          )}
        </form>
      )}
    </div>
  );
}
