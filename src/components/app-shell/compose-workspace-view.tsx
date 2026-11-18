import { useEffect, useMemo, useRef } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { useEnvironmentTemplates } from "../../hooks/useEnvironmentTemplates";
import { HarnessRuntimeSelector } from "../harness-runtime-selector";
import { ServerSettingsForm } from "../server-settings-form";
import type { ServerSettings } from "@/shared/settings";
import {
  isIncompleteGitHubRepositoryUrl,
  parseExecutionHostRef,
  HARNESS_ADAPTER_IDS,
  serializeExecutionHostRef,
  type ExecutionHostRef,
} from "@/shared";
import { Button } from "../common";
import {
  ErrorState,
  FormGroup,
  SelectField,
  TextField,
  useHeaderActions,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { useWorkspaceExecutionTargets } from "../../hooks/workspace-server-settings";
import { useWorkerUpdatePreferences } from "../../hooks/useWorkerUpdatePreferences";
import { WorkerChannelSelect } from "../worker-channel-select";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { ProvisioningSshKeyPicker } from "../ProvisioningSshKeyPicker";

interface ComposeWorkspaceViewProps {
  navigateWithinShell: (route: WebAppRoute) => void;
  workspaceCreate: UseWorkspaceCreateResult;
  provisioning: UseProvisioningJobResult;
  workspacesSaving: boolean;
  dashboardData: Pick<UseDashboardDataResult, "remoteOnly">;
}

const COMPOSE_AUTOMATIC_ADVANCED_PANEL_ID = "compose-workspace-automatic-advanced-options-panel";

export function ComposeWorkspaceView(props: ComposeWorkspaceViewProps) {
  const {
    workspaceCreate,
    provisioning,
    workspacesSaving,
    dashboardData,
  } = props;

  const {
    workspaceCreateMode,
    workspaceControllerId,
    setWorkspaceControllerId,
    workspaceControllers,
    workspaceControllersLoading,
    workspaceControllersError,
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
    workspaceWorkerEnrollment,
    workspaceWorkerEnrollmentSelected,
    setWorkspaceWorkerEnrollmentSelected,
    cancelWorkspaceWorkerEnrollment,
    setWorkspaceServerSettings,
    workspaceServerSettingsValid,
    setWorkspaceServerSettingsValid,
    workspaceTesting,
    workspaceCreateSubmitting,
    automaticExecutionHost,
    setAutomaticExecutionHost,
    automaticWorkerEnrollmentRoute,
    setAutomaticWorkerEnrollmentRoute,
    automaticWorkerRelayName,
    setAutomaticWorkerRelayName,
    relayOptions,
    primaryRelayName,
    automaticRelayAvailable,
    automaticRelayStatusLoading,
    automaticRepoUrl,
    setAutomaticRepoUrl,
    automaticCreateNewRepository,
    setAutomaticCreateNewRepository,
    automaticBasePath,
    setAutomaticBasePath,
    automaticDevcontainerSubpath,
    setAutomaticDevcontainerSubpath,
    automaticEnvironmentTemplate,
    setAutomaticEnvironmentTemplate,
    automaticGithubUser,
    setAutomaticGithubUser,
    automaticSshKeyIds,
    setAutomaticSshKeyIds,
    automaticAdvancedOpen,
    setAutomaticAdvancedOpen,
    automaticAdapter,
    setAutomaticAdapter,
    automaticChannel,
    setAutomaticChannel,
    handleCreateWorkspace,
    handleTestWorkspaceConnection,
  } = workspaceCreate;
  const automaticWorker = workspaceCreateMode === "automatic"
    && !workspaceWorkerEnrollmentSelected;
  const channelPreferences = useWorkerUpdatePreferences({ enabled: automaticWorker });
  const { targets: executionTargets } = useWorkspaceExecutionTargets({ controllerId: workspaceControllerId || undefined });
  const localAdministration = getClankyClientCapabilities().controllerAdministration;
  const automaticExecutionTargets = useMemo(
    () => executionTargets.filter((target) =>
      Boolean(target.capabilities.provisioning)
      && (!dashboardData.remoteOnly || target.ref.kind !== "local")
    ),
    [dashboardData.remoteOnly, executionTargets],
  );
  const autoSelectedEnvironmentTemplateRef = useRef<string | null>(null);

  const workspaceCreateFormId = "workspace-create-form";
  const {
    templates,
    templatesLoading,
    templatesError,
    refreshTemplates,
  } = useEnvironmentTemplates({
    executionHost: automaticExecutionHost,
  });
  useEffect(() => {
    if (!automaticCreateNewRepository || automaticEnvironmentTemplate || templatesLoading) {
      return;
    }
    const firstTemplate = templates[0]?.name;
    if (firstTemplate) {
      autoSelectedEnvironmentTemplateRef.current = firstTemplate;
      setAutomaticEnvironmentTemplate(firstTemplate);
    }
  }, [automaticCreateNewRepository, automaticEnvironmentTemplate, setAutomaticEnvironmentTemplate, templates, templatesLoading]);
  const automaticFormValid =
    (!automaticWorker || automaticChannel !== "default"
      || (channelPreferences.data !== undefined && !channelPreferences.error)) &&
    !workspaceWorkerEnrollmentSelected &&
    workspaceName.trim().length > 0 &&
    (automaticExecutionHost !== null
      || (
        workspaceWorkerEnrollmentSelected
        && workspaceWorkerEnrollment?.enrollment.status === "connected"
      )) &&
    (automaticCreateNewRepository || (
      automaticRepoUrl.trim().length > 0
      && !isIncompleteGitHubRepositoryUrl(automaticRepoUrl)
    )) &&
    automaticBasePath.trim().length > 0 &&
    (!automaticCreateNewRepository || automaticEnvironmentTemplate.trim().length > 0);
  const manualFormValid =
    (localAdministration || Boolean(workspaceControllerId)) &&
    workspaceName.trim().length > 0 &&
    workspaceDirectory.trim().length > 0 &&
    workspaceExecutionHost !== null &&
    workspaceServerSettingsValid;
  const createActionLabel =
    workspaceCreateMode === "automatic" ? "Start provisioning" : "Create";
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
        disabled={Boolean(workspaceControllerId) || !localAdministration}
        variant={workspaceCreateMode === "automatic" ? "primary" : "secondary"}
        onClick={() => setWorkspaceCreateMode("automatic")}
      >
        Automatic
      </Button>
    </>
  );

  const headerActions = useMemo(() => [{
    id: "create-workspace",
    label: createActionLabel,
    form: workspaceCreateFormId,
    loading: createActionLoading,
    disabled: createActionDisabled,
  }], [
    createActionDisabled,
    createActionLabel,
    createActionLoading,
    workspaceCreateFormId,
  ]);
  useHeaderActions({ primary: headerActions });

  return (
    <div className="space-y-6">
      <form
          id={workspaceCreateFormId}
          className="space-y-6"
          onSubmit={(event) => handleCreateWorkspace(event)}
        >
          {workspaceControllersError ? <ErrorState title="Controller access unavailable" description={workspaceControllersError} /> : null}
          {workspaceControllers.length > 0 && <SelectField label="Controller" value={workspaceControllerId}
            disabled={workspaceControllersLoading || createActionLoading || workspaceWorkerEnrollment !== null}
            onChange={(event) => setWorkspaceControllerId(event.currentTarget.value)}>
            {localAdministration ? <option value="">This instance</option> : <option value="" disabled>Select a controller</option>}
            {workspaceControllers.map((controller) => <option key={controller.id} value={controller.id}>{controller.name}</option>)}
          </SelectField>}
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
            <ServerSettingsForm
              key={workspaceControllerId}
              controllerId={workspaceControllerId || undefined}
              initialSettings={workspaceServerSettings}
              initialExecutionHost={workspaceExecutionHost}
              onChange={(
                settings: ServerSettings,
                isValid: boolean,
                executionHost: ExecutionHostRef | null,
              ) => {
                setWorkspaceServerSettings((current: ServerSettings) => {
                  return JSON.stringify(current) === JSON.stringify(settings) ? current : settings;
                });
                if (executionHost) {
                  if (workspaceWorkerEnrollment) {
                    void cancelWorkspaceWorkerEnrollment();
                  }
                  setWorkspaceWorkerEnrollmentSelected(false);
                }
                setWorkspaceExecutionHost(executionHost);
                setWorkspaceServerSettingsValid(isValid);
              }}
              onTest={handleTestWorkspaceConnection}
              testing={workspaceTesting}
              remoteOnly={workspaceControllerId ? false : dashboardData.remoteOnly}
            >
              <div className="space-y-4">
                <TextField
                  id="workspace-directory"
                  label="Directory"
                  hint="Path on the selected execution host."
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
                    <span className="block font-medium">Git repository</span>
                  </span>
                </label>
              </div>
            </ServerSettingsForm>
          ) : (
            <div className="space-y-4">
              <SelectField
                id="automatic-execution-kind"
                label="Provisioning and execution host"
                value={automaticExecutionHost
                  ? serializeExecutionHostRef(automaticExecutionHost)
                          : workspaceWorkerEnrollmentSelected
                            && workspaceWorkerEnrollment?.enrollment.status === "connected"
                            ? "workspace-worker"
                            : ""}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "workspace-worker") {
                    setWorkspaceWorkerEnrollmentSelected(true);
                    setAutomaticExecutionHost(null);
                    setAutomaticBasePath("/workspaces");
                    setAutomaticEnvironmentTemplate("");
                    return;
                  }
                  if (workspaceWorkerEnrollment) {
                    void cancelWorkspaceWorkerEnrollment();
                  }
                  setWorkspaceWorkerEnrollmentSelected(false);
                  const host = value ? parseExecutionHostRef(value) : null;
                  setAutomaticExecutionHost(host);
                  setAutomaticEnvironmentTemplate("");
                  const selectedTarget = executionTargets.find(
                    (target) => host
                      && serializeExecutionHostRef(target.ref) === serializeExecutionHostRef(host),
                  );
                  setAutomaticBasePath(selectedTarget?.repositoriesBasePath ?? "/workspaces");
                }}
              >
                <option value="">Select an execution host</option>
                {workspaceWorkerEnrollment && (
                  <option
                    value="workspace-worker"
                    disabled={workspaceWorkerEnrollment.enrollment.status !== "connected"}
                  >
                    Dedicated worker ({workspaceWorkerEnrollment.enrollment.status})
                  </option>
                )}
                {automaticExecutionTargets.map((target) => (
                    <option
                      key={target.targetKey}
                      value={serializeExecutionHostRef(target.ref)}
                    >
                      {target.name} via {target.ref.kind}
                    </option>
                ))}
              </SelectField>

              {automaticExecutionHost && !workspaceWorkerEnrollmentSelected && (
                <>
                  <SelectField
                    id="automatic-worker-route"
                    label="Worker connection"
                    value={automaticWorkerEnrollmentRoute}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "direct" || value === "relay") {
                        setAutomaticWorkerEnrollmentRoute(value);
                      }
                    }}
                    disabled={automaticRelayStatusLoading}
                    required
                  >
                    <option value="direct">Direct to controller</option>
                    {(automaticRelayAvailable || automaticWorkerEnrollmentRoute === "relay") && (
                      <option value="relay" disabled={!automaticRelayAvailable}>
                        {automaticRelayAvailable ? "Via Clanky Relay" : "Via Clanky Relay (unavailable)"}
                      </option>
                    )}
                  </SelectField>
                    {automaticWorkerEnrollmentRoute === "relay" ? (
                      <SelectField
                        id="automatic-worker-relay"
                        label="Relay"
                        value={automaticWorkerRelayName}
                        onChange={(event) => setAutomaticWorkerRelayName(event.target.value)}
                        disabled={automaticRelayStatusLoading}
                      >
                        <option value="">
                          {primaryRelayName ? `Primary (${primaryRelayName})` : "Select a relay"}
                        </option>
                        {automaticWorkerRelayName
                          && !relayOptions.some((relay) =>
                            relay.name === automaticWorkerRelayName) ? (
                          <option value={automaticWorkerRelayName} disabled>
                            {automaticWorkerRelayName} (no longer paired)
                          </option>
                        ) : null}
                        {relayOptions.map((relay) => (
                          <option key={relay.name} value={relay.name}>{relay.name}</option>
                        ))}
                      </SelectField>
                    ) : null}
                </>
              )}

              {automaticExecutionTargets.length === 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  No execution host is available for automatic workspace provisioning.
                </p>
              )}

              <TextField
                id="automatic-repo-url"
                label="Git repository URL"
                value={automaticRepoUrl}
                onChange={(event) => setAutomaticRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo.git"
                required={!automaticCreateNewRepository}
                disabled={automaticCreateNewRepository}
              />
              {!automaticCreateNewRepository && isIncompleteGitHubRepositoryUrl(automaticRepoUrl) && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Enter a repository name after the GitHub username.
                </p>
              )}
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={automaticCreateNewRepository}
                  onChange={(event) => {
                    const createNewRepository = event.target.checked;
                    setAutomaticCreateNewRepository(createNewRepository);
                    if (
                      !createNewRepository
                      && autoSelectedEnvironmentTemplateRef.current
                      && automaticEnvironmentTemplate === autoSelectedEnvironmentTemplateRef.current
                    ) {
                      setAutomaticEnvironmentTemplate("");
                    }
                    autoSelectedEnvironmentTemplateRef.current = null;
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <HarnessRuntimeSelector idPrefix="automatic-" adapter={automaticAdapter}
                  supportedAdapters={!workspaceWorkerEnrollmentSelected ? HARNESS_ADAPTER_IDS : []}
                  onAdapterChange={setAutomaticAdapter} />
              </div>
              {automaticWorker ? (
                <>
                  <WorkerChannelSelect
                    id="automatic-clanky-channel"
                    value={automaticChannel}
                    onChange={setAutomaticChannel}
                    disabled={provisioning.starting}
                  />
                  {channelPreferences.error ? (
                    <ErrorState title="Unable to load the default Clanky channel" description={String(channelPreferences.error)} />
                  ) : null}
                </>
              ) : null}
              {workspaceWorkerEnrollmentSelected && (
                <ErrorState title="Adapter unavailable" description="Native adapters require an automatic worker workspace." />
              )}

              <FormGroup title="SSH keys" description="Share selected keys with this workspace and its initial clone. No keys are shared by default.">
                <ProvisioningSshKeyPicker
                  keyIds={automaticSshKeyIds}
                  onChange={setAutomaticSshKeyIds}
                  disabled={workspaceCreateSubmitting}
                />
              </FormGroup>
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
                      title="Environment template"
                      actions={(
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => { void refreshTemplates(); }}
                        >
                          Refresh templates
                        </Button>
                      )}
                    >
                      {!automaticExecutionHost && workspaceWorkerEnrollment ? (
                        <TextField
                          id="automatic-environment-template"
                          label="Environment template"
                          value={automaticEnvironmentTemplate}
                          onChange={(event) => setAutomaticEnvironmentTemplate(event.target.value)}
                          placeholder="node"
                          required={automaticCreateNewRepository}
                        />
                      ) : (
                        <SelectField
                          id="automatic-environment-template"
                          label="Template"
                          value={automaticEnvironmentTemplate}
                          onChange={(event) => {
                            autoSelectedEnvironmentTemplateRef.current = null;
                            setAutomaticEnvironmentTemplate(event.target.value);
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
                      )}
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
                      disabled={automaticEnvironmentTemplate.length > 0}
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
