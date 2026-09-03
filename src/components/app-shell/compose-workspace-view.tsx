import { useEffect, useMemo, useRef } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { useDevboxTemplates } from "../../hooks/useDevboxTemplates";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings } from "@/shared/settings";
import type { AgentProvider } from "@/shared/settings";
import { Button, PASSWORD_INPUT_PROPS } from "../common";
import {
  ErrorState,
  FormGroup,
  SelectField,
  TextField,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { SshServer } from "@/shared/ssh-server";
import {
  getAutomaticWorkspaceBasePath,
  saveLastAutomaticWorkspaceSshServerId,
} from "../../lib/automatic-workspace-preferences";
import { useShellHeaderActions } from "./shell-header-actions";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";

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
    workspaceType,
    setWorkspaceType,
    workspaceServerSettings,
    workspaceExecutionNodeId,
    setWorkspaceExecutionNodeId,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticServerId,
    setAutomaticServerId,
    automaticExecutionNodeId,
    setAutomaticExecutionNodeId,
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
  } = workspaceCreate;
  const { targets: executionTargets } = useWorkspaceExecutionTargets();
  const autoSelectedDevboxTemplateRef = useRef<string | null>(null);

  const workspaceCreateFormId = "workspace-create-form";
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
    (Boolean(automaticExecutionNodeId) || automaticServerId.trim().length > 0) &&
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
    <Button
      type="submit"
      form={workspaceCreateFormId}
      size="sm"
      loading={createActionLoading}
      disabled={createActionDisabled}
    >
      {createActionLabel}
    </Button>
  ), [
    createActionDisabled,
    createActionLabel,
    createActionLoading,
    workspaceCreateFormId,
  ]);
  useShellHeaderActions(headerActions);

  return (
    <div className="space-y-6">
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
              />
              <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={workspaceType === "git"}
                  onChange={(event) => setWorkspaceType(event.target.checked ? "git" : "directory")}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="flex-1">
                  <span className="block font-medium">Enable task features</span>
                </span>
              </label>
              <ServerSettingsForm
                initialSettings={workspaceServerSettings}
                initialExecutionNodeId={workspaceExecutionNodeId}
                onChange={(settings: ServerSettings, isValid: boolean, executionNodeId: string | null) => {
                  setWorkspaceServerSettings((current: ServerSettings) => {
                    return JSON.stringify(current) === JSON.stringify(settings) ? current : settings;
                  });
                  setWorkspaceExecutionNodeId(executionNodeId);
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
                id="automatic-execution-kind"
                label="Provisioning and execution host"
                value={automaticExecutionNodeId ?? ""}
                onChange={(event) => setAutomaticExecutionNodeId(event.target.value || null)}
              >
                <option value="">Saved SSH server (devbox SSH)</option>
                {executionTargets
                  .filter((target) => !dashboardData.remoteOnly || target.kind === "mesh")
                  .map((target) => (
                    <option key={target.nodeId} value={target.nodeId}>
                      {target.name} via stdio
                      {target.availability === "offline" ? " (offline)" : ""}
                    </option>
                  ))}
              </SelectField>

              {!automaticExecutionNodeId && (
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
              )}
                {!automaticExecutionNodeId && servers.length === 0 && (
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
                label="Base path"
                value={automaticBasePath}
                onChange={(event) => setAutomaticBasePath(event.target.value)}
                placeholder="/workspaces"
                required
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

              {!automaticExecutionNodeId && !selectedServerHasStoredCredential && (
                <TextField
                  id="automatic-ssh-password"
                  label="SSH password"
                  value={automaticPassword}
                  onChange={(event) => setAutomaticPassword(event.target.value)}
                  placeholder="Leave blank for key-based auth"
                  type="password"
                  {...PASSWORD_INPUT_PROPS}
                />
              )}

              <FormGroup
                title="Advanced options"
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
                    />

                    <TextField
                      id="automatic-devcontainer-subpath"
                      label="Devcontainer variant"
                      value={automaticDevcontainerSubpath}
                      onChange={(event) => setAutomaticDevcontainerSubpath(event.target.value)}
                      placeholder="backend"
                      disabled={automaticDevboxTemplate.length > 0}
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
    </div>
  );
}
