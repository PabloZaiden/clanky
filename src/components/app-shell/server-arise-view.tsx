import { useState } from "react";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { getStoredSshServerCredential } from "../../lib/ssh-browser-credentials";
import type { SshServer } from "@/shared";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { Badge, Button, PASSWORD_INPUT_PROPS, StatusBadge } from "../common";
import { ErrorState, FormGroup, TextField, type WebAppRoute } from "@pablozaiden/webapp/web";
import { getProvisioningStatusBadgeVariant } from "./shell-types";
import { useShellHeaderActions } from "./shell-header-actions";

interface ServerAriseViewProps {
  server: SshServer;
  provisioning: UseProvisioningJobResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function ServerAriseView({
  server,
  provisioning,
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
      devboxTemplate: null,
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

  const headerActions = (
    <>
      <Badge variant="info" size="sm">Arise</Badge>
      {provisioningStatus && (
        <StatusBadge variant={getProvisioningStatusBadgeVariant(provisioningStatus)} size="sm">
          {provisioningStatus}
        </StatusBadge>
      )}
      {provisioning.activeJobId ? (
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
      )}
    </>
  );
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
          id={formId}
          className="space-y-6"
          onSubmit={(event) => void handleStartArise(event)}
        >
          <FormGroup title="Server details">
            <div className="space-y-4">
            <TextField
              id="server-arise-server-name"
              label="Server name"
              value={server.config.name}
              disabled
            />

            <TextField
              id="server-arise-address"
              label="Address"
              value={server.config.address}
              disabled
            />

            <TextField
              id="server-arise-username"
              label="Username"
              value={server.config.username}
              disabled
            />

            <TextField
              id="server-arise-base-path"
              label="Repositories base path"
              value={server.config.repositoriesBasePath ?? ""}
              disabled
              hint="This server already supports automatic workspace provisioning."
            />

            {!hasStoredCredential && (
              <TextField
                id="server-arise-password"
                label="SSH password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Leave blank for key-based auth"
                type="password"
                hint="Required to connect to the SSH server when password auth is needed."
                {...PASSWORD_INPUT_PROPS}
              />
            )}
            </div>
          </FormGroup>

          {provisioning.error && (
            <ErrorState title="Unable to run devbox arise" description={provisioning.error} />
          )}
        </form>
      )}
    </div>
  );
}
