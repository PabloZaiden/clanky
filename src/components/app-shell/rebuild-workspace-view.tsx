import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { Button, PASSWORD_INPUT_PROPS } from "../common";
import { ErrorState, FormGroup, SelectField, TextField, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared/workspace";
import type { SshServer } from "@/shared/ssh-server";
import type { ProvisioningJobMode } from "@/shared/provisioning";
import { useState } from "react";
import { useShellHeaderActions } from "./shell-header-actions";

interface RebuildWorkspaceViewProps {
  mode: Extract<ProvisioningJobMode, "rebuild" | "restart">;
  workspace: Workspace;
  servers: SshServer[];
  provisioning: UseProvisioningJobResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function RebuildWorkspaceView({
  mode,
  workspace,
  servers,
  provisioning,
  navigateWithinShell,
}: RebuildWorkspaceViewProps) {
  const [password, setPassword] = useState("");
  const actionLabel = mode === "restart" ? "Restart" : "Rebuild";
  const actionLabelLower = actionLabel.toLowerCase();
  const formId = `${mode}-workspace-form`;

  const executionHost = workspace.executionHostBinding.host;
  const sshServerId = executionHost.kind === "ssh" ? executionHost.serverId : "";
  const selectedServer = servers.find((s) => s.config.id === sshServerId);
  const selectedServerHasStoredCredential = sshServerId
    ? getStoredSshServerCredential(sshServerId) !== null
    : false;

  async function handleStartWorkspaceAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const snapshot = await provisioning.startJob({
      name: workspace.name,
      executionHost,
      repoUrl: workspace.repoUrl ?? "",
      basePath: workspace.basePath ?? "",
      devcontainerSubpath: workspace.devcontainerSubpath ?? null,
      devboxTemplate: null,
      provider: workspace.serverSettings.agent.provider,
      password,
      mode,
      targetDirectory: workspace.sourceDirectory ?? null,
      workspaceId: workspace.id,
    });

    if (snapshot) {
      setPassword("");
      navigateWithinShell({
        view: "provisioning-job",
        provisioningJobId: snapshot.job.config.id,
        returnView: "workspace",
        returnId: workspace.id,
      });
    }
  }

  const headerActions = (
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
        disabled={executionHost.kind === "ssh" && !selectedServer}
      >
        {`${actionLabel} Devbox`}
      </Button>
    </>
  );
  useShellHeaderActions(headerActions);

  return (
    <div className="space-y-6">
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
                label="Execution host"
                id={`${mode}-ssh-server`}
                value={sshServerId}
                disabled
              >
                {executionHost.kind !== "ssh" && (
                  <option value="">{executionHost.kind}</option>
                )}
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
            />

            <TextField
              id={`${mode}-provider`}
              label="Provider"
              value={workspace.serverSettings.agent.provider}
              disabled
            />

            <TextField
              id={`${mode}-devcontainer-subpath`}
              label="Devcontainer variant"
              value={workspace.devcontainerSubpath ?? ""}
              disabled
            />

            {!selectedServerHasStoredCredential && sshServerId && (
              <TextField
                id={`${mode}-ssh-password`}
                label="SSH password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Leave blank for key-based auth"
                type="password"
                {...PASSWORD_INPUT_PROPS}
              />
            )}
            </div>
          </FormGroup>

          {provisioning.error && (
            <ErrorState title={`Unable to ${actionLabelLower} workspace`} description={provisioning.error} />
          )}
      </form>
    </div>
  );
}
