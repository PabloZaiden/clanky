import { useMemo, useState } from "react";
import {
  ConfirmModal,
  SettingsFieldRow,
  createLogger,
  useToast,
} from "@pablozaiden/webapp/web";
import type {
  RestartAutomaticWorkspacesRequest,
  RestartAutomaticWorkspacesResponse,
} from "@/contracts";
import {
  isRestartableAutomaticWorkspace,
  type Workspace,
} from "@/shared";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import {
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
} from "../../lib/ssh-browser-credentials";
import { Button } from "../common";

const log = createLogger("RestartAutomaticWorkspacesAction");

export function RestartAutomaticWorkspacesAction({
  workspaces,
  workspacesLoading,
  restarting,
  onRestartAutomaticWorkspaces,
}: {
  workspaces: Workspace[];
  workspacesLoading: boolean;
  restarting: boolean;
  onRestartAutomaticWorkspaces: (
    request: RestartAutomaticWorkspacesRequest,
  ) => Promise<RestartAutomaticWorkspacesResponse | null>;
}) {
  const toast = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [preparingCredentials, setPreparingCredentials] = useState(false);
  const automaticWorkspaces = useMemo(
    () => workspaces.filter(isRestartableAutomaticWorkspace),
    [workspaces],
  );
  const sshServerIds = useMemo(() => [
    ...new Set(
      automaticWorkspaces
        .map((workspace) => getRegisteredSshServerId(
          (workspace.provisioningHostBinding ?? workspace.executionHostBinding).host,
        ))
        .filter((serverId): serverId is string => serverId !== null),
    ),
  ], [automaticWorkspaces]);
  const busy = restarting || preparingCredentials;

  async function confirmRestart(): Promise<void> {
    setPreparingCredentials(true);
    try {
      const credentialTokensByServerId: Record<string, string> = {};
      const credentialUnavailableServerIds: string[] = [];
      const credentialResults = await Promise.allSettled(
        sshServerIds.map(async (serverId) => {
          const hadStoredCredential = getStoredSshServerCredential(serverId) !== null;
          return {
            serverId,
            hadStoredCredential,
            credentialToken: await getStoredSshCredentialToken(serverId),
          };
        }),
      );

      credentialResults.forEach((result, index) => {
        const serverId = sshServerIds[index]!;
        if (result.status === "rejected") {
          credentialUnavailableServerIds.push(serverId);
          log.warn("Unable to retrieve saved SSH credential for automatic workspace restart", {
            serverId,
            error: String(result.reason),
          });
          return;
        }
        if (result.value.credentialToken) {
          credentialTokensByServerId[serverId] = result.value.credentialToken;
        } else if (result.value.hadStoredCredential) {
          credentialUnavailableServerIds.push(serverId);
          log.warn("Saved SSH credential is no longer usable for automatic workspace restart", {
            serverId,
          });
        }
      });

      const result = await onRestartAutomaticWorkspaces({
        credentialTokensByServerId,
        credentialUnavailableServerIds,
      });
      setShowConfirm(false);
      if (result) {
        if (result.failures.length > 0) {
          toast.error(
            `Started ${result.started.length} of ${result.totalWorkspaces} automatic workspace restart jobs; ${result.failures.length} failed.`,
          );
        } else if (result.totalWorkspaces === 0 || result.started.length === 0) {
          toast.info("No automatic workspaces are eligible for restart.");
        } else {
          toast.success(`Started restart jobs for ${result.started.length} automatic workspaces.`);
        }
      }
    } catch (error) {
      log.error("Failed to prepare automatic workspace restarts", {
        error: String(error),
      });
      toast.error("Failed to prepare automatic workspace restarts");
      setShowConfirm(false);
    } finally {
      setPreparingCredentials(false);
    }
  }

  return (
    <>
      <SettingsFieldRow title="Automatic workspaces" actions={<Button
        type="button"
        size="sm"
        loading={busy}
        disabled={busy || workspacesLoading || automaticWorkspaces.length === 0}
        onClick={() => setShowConfirm(true)}
      >
        Restart all
      </Button>} feedback={
        !workspacesLoading && automaticWorkspaces.length === 0
          ? <small>No automatic workspaces</small>
          : null
      } />
      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => {
          if (!busy) {
            setShowConfirm(false);
          }
        }}
        onConfirm={() => void confirmRestart()}
        title="Restart automatic workspaces?"
        message={`Restart ${automaticWorkspaces.length} workspaces? Active sessions may disconnect.`}
        confirmLabel="Restart workspaces"
        loading={busy}
      />
    </>
  );
}
