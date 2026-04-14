import { useState } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import type { SshServer } from "../../types";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { Badge, Button, PASSWORD_INPUT_PROPS } from "../common";
import { InlineField, ShellPanel } from "./shell-panel";
import type { ShellRoute } from "./shell-types";
import { getProvisioningStatusBadgeVariant } from "./shell-types";

interface ServerAriseViewProps {
  server: SshServer;
  provisioning: UseProvisioningJobResult;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
}

export function ServerAriseView({
  server,
  provisioning,
  shellHeaderOffsetClassName,
  navigateWithinShell,
}: ServerAriseViewProps) {
  const [password, setPassword] = useState("");
  const formId = "server-arise-form";
  const provisioningStatus = provisioning.snapshot?.job.state.status;
  const canReturnToForm =
    provisioningStatus === "failed" || provisioningStatus === "cancelled";
  const hasStoredCredential = getStoredSshServerCredential(server.config.id) !== null;

  async function handleStartArise(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const snapshot = await provisioning.startJob({
      name: server.config.name,
      sshServerId: server.config.id,
      repoUrl: "",
      basePath: server.config.repositoriesBasePath ?? "",
      devcontainerSubpath: null,
      provider: "copilot",
      password,
      mode: "arise",
      targetDirectory: null,
      workspaceId: null,
    });

    if (snapshot) {
      setPassword("");
    }
  }

  function handleBackToForm() {
    provisioning.clearActiveJob();
    setPassword("");
  }

  return (
    <ShellPanel
      eyebrow="SSH server"
      title={`Arise ${server.config.name}`}
      description="Run devbox arise on this server to revive existing stopped devboxes."
      variant="compact"
      headerOffsetClassName={shellHeaderOffsetClassName}
      badges={
        <>
          <Badge variant="info" size="sm">Arise</Badge>
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
                Back to Arise Form
              </Button>
            )}
            {provisioningStatus === "completed" && (
              <Button
                type="button"
                size="sm"
                onClick={() => navigateWithinShell({ view: "ssh-server-settings", serverId: server.config.id })}
              >
                Back to Settings
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
                Cancel Arise
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigateWithinShell({ view: "ssh-server-settings", serverId: server.config.id })}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              size="sm"
              loading={provisioning.starting}
            >
              Run devbox arise
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
          onSubmit={(event) => void handleStartArise(event)}
        >
          <div className="space-y-4">
            <InlineField
              id="server-arise-server-name"
              label="Server name"
              value={server.config.name}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id="server-arise-address"
              label="Address"
              value={server.config.address}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id="server-arise-username"
              label="Username"
              value={server.config.username}
              onChange={() => {}}
              disabled
            />

            <InlineField
              id="server-arise-base-path"
              label="Repositories base path"
              value={server.config.repositoriesBasePath ?? ""}
              onChange={() => {}}
              disabled
              help="This server already supports automatic workspace provisioning."
            />

            {!hasStoredCredential && (
              <InlineField
                id="server-arise-password"
                label="SSH password"
                value={password}
                onChange={setPassword}
                placeholder="Leave blank for key-based auth"
                type="password"
                help="Required to connect to the SSH server when password auth is needed."
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
