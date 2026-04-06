import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { ServerSettingsForm } from "../ServerSettingsForm";
import type { ServerSettings } from "../../types/settings";
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
    automaticBasePath,
    setAutomaticBasePath,
    automaticDevcontainerSubpath,
    setAutomaticDevcontainerSubpath,
    automaticProvider,
    setAutomaticProvider,
    automaticPassword,
    setAutomaticPassword,
    handleCreateWorkspace,
    handleTestWorkspaceConnection,
    handleBackToAutomaticWorkspaceForm,
  } = workspaceCreate;

  const workspaceCreateFormId = "workspace-create-form";
  const provisioningStatus = provisioning.snapshot?.job.state.status;
  const provisionedWorkspaceId =
    provisioning.snapshot?.workspace?.id ?? provisioning.snapshot?.job.state.workspaceId;
  const canReturnToAutomaticForm =
    provisioningStatus === "failed" || provisioningStatus === "cancelled";
  const selectedServerHasStoredCredential = automaticServerId
    ? getStoredSshServerCredential(automaticServerId) !== null
    : false;
  const automaticFormValid =
    workspaceName.trim().length > 0 &&
    automaticServerId.trim().length > 0 &&
    automaticRepoUrl.trim().length > 0 &&
    automaticBasePath.trim().length > 0;
  const manualFormValid =
    workspaceName.trim().length > 0 &&
    workspaceDirectory.trim().length > 0 &&
    workspaceServerSettingsValid;

  return (
    <ShellPanel
      eyebrow="Workspace"
      title="Create a workspace"
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      badges={
        <>
          <Badge variant={workspaceCreateMode === "automatic" ? "info" : "default"} size="sm">
            {workspaceCreateMode === "automatic" ? "Automatic" : "Manual"}
          </Badge>
          {provisioningStatus && (
            <Badge variant={getProvisioningStatusBadgeVariant(provisioningStatus)} size="sm">
              {provisioningStatus}
            </Badge>
          )}
        </>
      }
      actions={
        provisioning.activeJobId ? (
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
        ) : (
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigateWithinShell({ view: "home" })}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={workspaceCreateFormId}
              size="sm"
              loading={
                workspaceCreateMode === "automatic"
                  ? provisioning.starting
                  : workspaceCreateSubmitting || workspacesSaving
              }
              disabled={workspaceCreateMode === "automatic" ? !automaticFormValid : !manualFormValid}
            >
              {workspaceCreateMode === "automatic" ? "Start Provisioning" : "Create Workspace"}
            </Button>
          </>
        )
      }
    >
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
                required
                help="Repository to clone on the remote host."
              />

              <InlineField
                id="automatic-base-path"
                label="Remote base path"
                value={automaticBasePath}
                onChange={setAutomaticBasePath}
                placeholder="/workspaces"
                required
                help="Parent directory where the repo should be cloned."
              />

              <InlineField
                id="automatic-devcontainer-subpath"
                label="Devcontainer subpath"
                value={automaticDevcontainerSubpath}
                onChange={setAutomaticDevcontainerSubpath}
                placeholder=".devcontainer/backend/devcontainer.json"
                help="Optional. Use when the repository contains multiple devcontainer definitions and devbox needs a specific one."
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
                    setAutomaticProvider(
                      event.target.value as import("../../types/settings").AgentProvider,
                    )
                  }
                  className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-300 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 dark:focus:border-gray-500 dark:focus:ring-gray-700"
                >
                  <option value="copilot">copilot</option>
                  <option value="opencode">opencode</option>
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
