import type { SshServer } from "@/shared/ssh-server";
import type { Workspace, WorkspaceExecutionTarget } from "@/shared/workspace";
import { getServerLabel } from "@/shared/settings";

/**
 * Resolve the execution target metadata needed to label a workspace without
 * mistaking a local stdio node for a remote peer.
 */
export function getWorkspaceServerLabel(
  workspace: Pick<Workspace, "serverSettings" | "executionNodeId">,
  registeredSshServers: readonly SshServer[],
  executionTargets: readonly WorkspaceExecutionTarget[],
): string {
  const nodeId = workspace.executionNodeId?.trim();
  if (!nodeId) {
    return getServerLabel(workspace.serverSettings, registeredSshServers);
  }

  const localNodeId = executionTargets.find((target) => target.kind === "local")?.nodeId;
  if (executionTargets.length === 0) {
    return `${workspace.serverSettings.agent.provider} via stdio on selected host`;
  }
  const target = executionTargets.find((candidate) => candidate.nodeId === nodeId);
  return getServerLabel(workspace.serverSettings, registeredSshServers, {
    nodeId,
    localNodeId,
    instanceName: target?.kind === "mesh" ? target.name : undefined,
  });
}
