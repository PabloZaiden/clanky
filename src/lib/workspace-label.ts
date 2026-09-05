import type { SshServer } from "@/shared/ssh-server";
import type { ExecutionHostDescriptor, Workspace } from "@/shared";
import { getServerLabel } from "@/shared/settings";

/**
 * Resolve the execution target metadata needed to label a workspace without
 * mistaking a local stdio node for a remote peer.
 */
export function getWorkspaceServerLabel(
  workspace: Pick<Workspace, "serverSettings" | "executionHostBinding">,
  _registeredSshServers: readonly SshServer[],
  executionTargets: readonly ExecutionHostDescriptor[],
): string {
  const target = executionTargets.find(
    (candidate) => candidate.targetKey === workspace.executionHostBinding.targetKey,
  );
  return getServerLabel(workspace.serverSettings, target ?? {
    ref: workspace.executionHostBinding.host,
    name: "selected host",
  });
}
