import type { ExecutionHostDescriptor, Workspace } from "@/shared";
import { getServerLabel } from "@/shared/settings";

export function getWorkspaceDisplayName(workspace: Pick<Workspace, "name" | "collaboration">): string {
  return workspace.collaboration
    ? `${workspace.name} (${workspace.collaboration.controllerName})`
    : workspace.name;
}

/**
 * Resolve the execution target metadata needed to label a workspace without
 * mistaking a local stdio node for a remote peer.
 */
export function getWorkspaceServerLabel(
  workspace: Pick<Workspace, "serverSettings" | "executionHostBinding">,
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
