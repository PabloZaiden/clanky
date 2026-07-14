import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import { ErrorState, FormGroup, Panel, SelectField, TextField, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getProvisioningStatusBadgeVariant } from "./shell-types";
import type { Workspace } from "@/shared/workspace";
import type { SshServer } from "@/shared/ssh-server";
import type { ProvisioningJobMode } from "@/shared/provisioning";
import { useState } from "react";

interface RebuildWorkspaceViewProps {
  mode: Extract<ProvisioningJobMode, "rebuild" | "restart">;
  workspace: Workspace;
  servers: SshServer[];
  provisioning: UseProvisioningJobResult;
  navigateWithinShell: (route: WebAppRoute) => void;
  refreshWorkspaces: () => Promise<void>;
}

export function RebuildWorkspaceView({
  mode,
  workspace,
  servers,
  provisioning,
  navigateWithinShell,
  refreshWorkspaces,
}: RebuildWorkspaceViewProps) {
  const [password, setPassword] = useState("");
  const actionLabel = mode === "restart" ? "Restart" : "Rebuild";
  const actionLabelLower = actionLabel.toLowerCase();
  const formId = `${mode}-workspace-form`;

  const sshServerId = workspace.sshServerId ?? "";
  const selectedServer = servers.find((s) => s.config.id === sshServerId);
  const selectedServerHasStoredCredential = sshServerId
    ? getStoredSshServerCredential(sshServerId) !== null
    : false;

  const provisioningStatus = provisioning.snapshot?.job.state.status;
  const canReturnToForm =
    provisioningStatus === "failed" || provisioningStatus === "cancelled";

  async function handleStartWorkspaceAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const snapshot = await provisioning.startJob({
      name: workspace.name,
      sshServerId,
      repoUrl: workspace.repoUrl ?? "",
      basePath: workspace.basePath ?? "",
      devcontainerSubpath: workspace.devcontainerSubpath ?? null,
      devboxTemplate: null,
      provider: workspace.provider ?? "copilot",
      password,
      mode,
      targetDirectory: workspace.sourceDirectory ?? null,
      workspaceId: workspace.id,
    });

    if (snapshot) {
      setPassword("");
    }
  }

  function handleBackToForm() {
    provisioning.clearActiveJob();
    setPassword("");
  }

  // When the action completes, refresh workspaces to get updated server settings.
  const isCompleted = provisioningStatus === "completed";
  const statusBadges = (
    <>
      <Badge variant="info" size="sm">{actionLabel}</Badge>
      {provisioningStatus && (
        <Badge variant={getProvisioningStatusBadgeVariant(provisioningStatus)} size="sm">
          {provisioningStatus}
        </Badge>
      )}
    </>
  );

  return (
    <Panel
      actions={(
        <>
          {statusBadges}
          {provisioning.activeJobId ? (
          <>
            {canReturnToForm && (
              <Button type="button" size="sm" onClick={handleBackToForm}>
                {`Back to ${actionLabel} Form`}
              </Button>
            )}
            {isCompleted && (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void refreshWorkspaces();
                  navigateWithinShell({ view: "workspace", workspaceId: workspace.id });
                }}
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
                {`Cancel ${actionLabel}`}
              </Button>
            )}
          </>
          ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigateWithinShell({ view: "workspace", workspaceId: workspace.id })}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              size="sm"
              loading={provisioning.starting}
              disabled={!sshServerId || (!!sshServerId && !selectedServer)}
            >
              {`${actionLabel} Devbox`}
            </Button>
          </>
          )}
        </>
      )}
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
          id={formId}
          className="space-y-6"
          onSubmit={(event) => void handleStartWorkspaceAction(event)}
        >
          <FormGroup title={`${actionLabel} details`}>
            <div className="space-y-4">
            <TextField
              id={`${mode}-workspace-name`}
              label="Workspace name"
              value={workspace.name}
              disabled
            />

            <div>
              <SelectField
                label="Saved SSH server"
                id={`${mode}-ssh-server`}
                value={sshServerId}
                disabled
              >
                <option value="">No SSH server</option>
                {servers.map((server) => (
                  <option key={server.config.id} value={server.config.id}>
                    {server.config.name} ({server.config.username}@{server.config.address})
                  </option>
                ))}
              </SelectField>
              {!selectedServer && sshServerId && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  The SSH server used for provisioning is no longer registered.
                </p>
              )}
            </div>

            <TextField
              id={`${mode}-repo-url`}
              label="Git repository URL"
              value={workspace.repoUrl ?? ""}
              disabled
            />

            <TextField
              id={`${mode}-base-path`}
              label="Remote base path"
              value={workspace.basePath ?? ""}
              disabled
            />

            <TextField
              id={`${mode}-source-directory`}
              label="Source directory"
              value={workspace.sourceDirectory ?? ""}
              disabled
              hint="Directory on the remote host where the repository was cloned."
            />

            <TextField
              id={`${mode}-provider`}
              label="Provider"
              value={workspace.provider ?? "copilot"}
              disabled
            />

            <TextField
              id={`${mode}-devcontainer-subpath`}
              label="Devcontainer variant"
              value={workspace.devcontainerSubpath ?? ""}
              disabled
              hint="If set, devbox will reuse this devcontainer variant during rebuild or restart."
            />

            {!selectedServerHasStoredCredential && sshServerId && (
              <TextField
                id={`${mode}-ssh-password`}
                label="SSH password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Leave blank for key-based auth"
                type="password"
                hint={`Required to connect to the SSH server for the ${actionLabelLower} operation.`}
                {...PASSWORD_INPUT_PROPS}
              />
            )}
            </div>
          </FormGroup>

          {provisioning.error && (
            <ErrorState title={`Unable to ${actionLabelLower} workspace`} description={provisioning.error} />
          )}
        </form>
      )}
    </Panel>
  );
}
