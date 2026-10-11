import { useMemo, useState } from "react";
import {
  ConfirmModal,
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
  const [restartResult, setRestartResult] = useState<RestartAutomaticWorkspacesResponse | null>(null);
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
        setRestartResult(result);
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
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        loading={busy}
        disabled={busy || workspacesLoading || automaticWorkspaces.length === 0}
        onClick={() => {
          setRestartResult(null);
          setShowConfirm(true);
        }}
      >
        Restart all
      </Button>
      {restartResult ? (
        <div
          role="status"
          className={`rounded px-2 py-1 text-sm ${
            restartResult.failures.length > 0
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
          }`}
        >
          {restartResult.totalWorkspaces === 0
            ? "No automatic workspaces are eligible for restart."
            : restartResult.failures.length > 0
              ? `Started ${restartResult.started.length} of ${restartResult.totalWorkspaces} restart jobs.`
              : `Started restart jobs for ${restartResult.started.length} automatic workspaces.`}
          {restartResult.started.length > 0 ? (
            <ul className="mt-1 space-y-1 text-xs">
              {restartResult.started.map((entry) => (
                <li key={entry.workspaceId}>
                  {entry.workspaceName}: <code>{entry.provisioningJobId}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {restartResult.failures.length > 0 ? (
            <ul className="mt-1 space-y-1 text-xs">
              {restartResult.failures.map((failure) => (
                <li key={failure.workspaceId}>
                  {failure.workspaceName}: {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
          {restartResult.started.length > 0 ? (
            <p className="mt-1 text-xs">Restart jobs continue in the background.</p>
          ) : null}
        </div>
      ) : null}
      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => {
          if (!busy) {
            setShowConfirm(false);
          }
        }}
        onConfirm={() => void confirmRestart()}
        title="Restart automatic workspaces?"
        message={`This starts restart jobs for ${automaticWorkspaces.length} automatically provisioned workspaces. Restarting may interrupt current workspace activity.`}
        confirmLabel="Start restart jobs"
        loading={busy}
      />
    </div>
  );
}
