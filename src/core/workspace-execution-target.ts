/**
 * Single authority for resolving a workspace's canonical execution host.
 */

import type { ExecutionHostBinding, ExecutionHostRef, Workspace } from "@/shared";

export interface ResolvedWorkspaceExecutionTarget {
  kind: ExecutionHostRef["kind"];
  hostRef: ExecutionHostRef;
  binding: ExecutionHostBinding;
  targetKey: string;
  nodeId: string;
}

export async function resolveWorkspaceExecutionTarget(
  workspace: Pick<Workspace, "id" | "executionHostBinding">,
): Promise<ResolvedWorkspaceExecutionTarget> {
  const binding = workspace.executionHostBinding;
  return {
    kind: binding.host.kind,
    hostRef: binding.host,
    binding,
    targetKey: binding.targetKey,
    nodeId: binding.host.nodeId,
  };
}
