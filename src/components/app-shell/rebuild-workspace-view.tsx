import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import { ShellPanel, InlineField } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
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
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  refreshWorkspaces: () => Promise<void>;
}

export function RebuildWorkspaceView({
  mode,
  workspace,
  servers,
  provisioning,
  shellHeaderOffsetClassName,
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

  return (
    <ShellPanel
      eyebrow="Workspace"
      title={`${actionLabel} ${workspace.name}`}
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      badges={
        <>
          <Badge variant="info" size="sm">{actionLabel}</Badge>
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
          id={formId}
          className="space-y-6"
          onSubmit={(event) => void handleStartWorkspaceAction(event)}
        >
          <div className="space-y-4">
            <InlineField
              id={`${mode}-workspace-name`}
              label="Workspace name"
              value={workspace.name}
              onChange={() => {}}
              disabled
            />

            <div>
              <label
                htmlFor={`${mode}-ssh-server`}
                className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Saved SSH server
              </label>
              <select
                id={`${mode}-ssh-server`}
                value={sshServerId}
                disabled
                className="block w-full rounded-xl border border-gray-300 bg-gray-100 px-3 py-2.5 text-sm text-gray-900 shadow-sm outline-none dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-100 cursor-not-allowed"
              >
                <option value="">No SSH server</option>
                {servers.map((server) => (
                  <option key={server.config.id} value={server.config.id}>
                    {server.config.name} ({server.config.username}@{server.config.address})
                  </option>
                ))}
              </select>
              {!selectedServer && sshServerId && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  The SSH server used for provisioning is no longer registered.
                </p>
              )}
            </div>

            <InlineField
              id={`${mode}-repo-url`}
              label="Git repository URL"
              value={workspace.repoUrl ?? ""}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id={`${mode}-base-path`}
              label="Remote base path"
              value={workspace.basePath ?? ""}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id={`${mode}-source-directory`}
              label="Source directory"
              value={workspace.sourceDirectory ?? ""}
              onChange={() => {}}
              disabled
              help="Directory on the remote host where the repository was cloned."
            />

            <InlineField
              id={`${mode}-provider`}
              label="Provider"
              value={workspace.provider ?? "copilot"}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id={`${mode}-devcontainer-subpath`}
              label="Devcontainer variant"
              value={workspace.devcontainerSubpath ?? ""}
              onChange={() => {}}
              disabled
              help="If set, devbox will reuse this devcontainer variant during rebuild or restart."
            />

            {!selectedServerHasStoredCredential && sshServerId && (
              <InlineField
                id={`${mode}-ssh-password`}
                label="SSH password"
                value={password}
                onChange={setPassword}
                placeholder="Leave blank for key-based auth"
                type="password"
                help={`Required to connect to the SSH server for the ${actionLabelLower} operation.`}
                inputProps={PASSWORD_INPUT_PROPS}
              />
            )}
          </div>

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
