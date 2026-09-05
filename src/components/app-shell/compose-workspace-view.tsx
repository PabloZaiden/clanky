import { useEffect, useMemo, useRef } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { useDevboxTemplates } from "../../hooks/useDevboxTemplates";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings } from "@/shared/settings";
import {
  getRegisteredSshServerId,
  parseExecutionHostRef,
  serializeExecutionHostRef,
  type ExecutionHostRef,
} from "@/shared";
import type { AgentProvider } from "@/shared/settings";
import type { WorkspaceSshTargetRequest } from "@/contracts/schemas";
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
    workspaceExecutionHost,
    setWorkspaceExecutionHost,
    workspaceSshTarget,
    setWorkspaceSshTarget,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticExecutionHost,
    setAutomaticExecutionHost,
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
  const automaticSshServerId = automaticExecutionHost
    ? getRegisteredSshServerId(automaticExecutionHost)
    : null;
  const selectedServerHasStoredCredential = automaticSshServerId
    ? getStoredSshServerCredential(automaticSshServerId) !== null
    : false;
  const {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  } = useDevboxTemplates({
    password: automaticPassword,
    executionHost: automaticExecutionHost,
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
    automaticExecutionHost !== null &&
    (automaticCreateNewRepository || automaticRepoUrl.trim().length > 0) &&
    automaticBasePath.trim().length > 0 &&
    (!automaticCreateNewRepository || automaticDevboxTemplate.trim().length > 0);
  const manualFormValid =
    workspaceName.trim().length > 0 &&
    workspaceDirectory.trim().length > 0 &&
    (workspaceExecutionHost !== null || workspaceSshTarget !== null) &&
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
                initialExecutionHost={workspaceExecutionHost}
                allowWorkspaceSshTarget
                onChange={(
                  settings: ServerSettings,
                  isValid: boolean,
                  executionHost: ExecutionHostRef | null,
                  sshTarget?: WorkspaceSshTargetRequest | null,
                ) => {
                  setWorkspaceServerSettings((current: ServerSettings) => {
                    return JSON.stringify(current) === JSON.stringify(settings) ? current : settings;
                  });
                  setWorkspaceExecutionHost(executionHost);
                  setWorkspaceSshTarget(sshTarget ?? null);
                  setWorkspaceServerSettingsValid(isValid);
                }}
                onTest={handleTestWorkspaceConnection}
                testing={workspaceTesting}
                remoteOnly={dashboardData.remoteOnly}
              />
            </>
          ) : (
            <div className="space-y-4">
              <SelectField
                id="automatic-execution-kind"
                label="Provisioning and execution host"
                value={automaticExecutionHost
                  ? serializeExecutionHostRef(automaticExecutionHost)
                  : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  const host = value ? parseExecutionHostRef(value) : null;
                  setAutomaticExecutionHost(host);
                  setAutomaticDevboxTemplate("");
                  const serverId = host ? getRegisteredSshServerId(host) : null;
                  if (serverId) {
                    saveLastAutomaticWorkspaceSshServerId(serverId);
                    const selectedServer = servers.find(
                      (server) => server.config.id === serverId,
                    );
                    setAutomaticBasePath(getAutomaticWorkspaceBasePath(selectedServer ?? null));
                    return;
                  }
                  const selectedTarget = executionTargets.find(
                    (target) => host
                      && serializeExecutionHostRef(target.ref) === serializeExecutionHostRef(host),
                  );
                  setAutomaticBasePath(selectedTarget?.repositoriesBasePath ?? "/workspaces");
                }}
              >
                <option value="">Select an execution host</option>
                {executionTargets
                  .filter((target) =>
                    !dashboardData.remoteOnly || target.ref.kind !== "local"
                  )
                  .map((target) => (
                    <option
                      key={target.targetKey}
                      value={serializeExecutionHostRef(target.ref)}
                    >
                      {target.name} via {target.ref.kind}
                    </option>
                  ))}
              </SelectField>

              {executionTargets.length === 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  No execution host is available for automatic workspace provisioning.
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

              {automaticExecutionHost?.kind === "ssh" && !selectedServerHasStoredCredential && (
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
                        disabled={!automaticExecutionHost || templatesLoading}
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
