/**
 * Single authority for resolving a workspace's canonical execution host.
 */

import type { ExecutionHostBinding, ExecutionHostRef, Workspace } from "@/shared";
import { isWorkspaceSshExecutionHostRef } from "@/shared/execution-host";
import { DomainError } from "../domain/domain-error";
import { getSshServerConfig } from "../persistence/ssh-servers";
import { getWorkspaceSshTarget } from "../persistence/workspace-execution-targets";
import type { SshConnectionTarget } from "./ssh-connection-target";

export type ResolvedWorkspaceExecutionTarget =
  | {
      kind: "local";
      hostRef: Extract<ExecutionHostRef, { kind: "local" }>;
      binding: ExecutionHostBinding;
      targetKey: string;
      nodeId: string;
    }
  | {
      kind: "mesh";
      hostRef: Extract<ExecutionHostRef, { kind: "mesh" }>;
      binding: ExecutionHostBinding;
      targetKey: string;
      nodeId: string;
    }
  | {
      kind: "ssh";
      hostRef: Extract<ExecutionHostRef, { kind: "ssh" }>;
      binding: ExecutionHostBinding;
      targetKey: string;
      target: SshConnectionTarget;
    };

export async function resolveWorkspaceExecutionTarget(
  workspace: Pick<Workspace, "id" | "executionHostBinding">,
): Promise<ResolvedWorkspaceExecutionTarget> {
  const binding = workspace.executionHostBinding;
  const host = binding.host;
  if (host.kind === "local") {
    return {
      kind: "local",
      hostRef: host,
      binding,
      targetKey: binding.targetKey,
      nodeId: host.nodeId,
    };
  }
  if (host.kind === "mesh") {
    return {
      kind: "mesh",
      hostRef: host,
      binding,
      targetKey: binding.targetKey,
      nodeId: host.nodeId,
    };
  }

  if (isWorkspaceSshExecutionHostRef(host)) {
    if (host.workspaceId !== workspace.id) {
      throw new DomainError(
        "workspace_execution_target_mismatch",
        "The workspace SSH execution target belongs to another workspace.",
        { details: { workspaceId: workspace.id, targetWorkspaceId: host.workspaceId } },
      );
    }
    const target = await getWorkspaceSshTarget(workspace.id);
    if (!target) {
      throw new DomainError(
        "workspace_execution_target_missing",
        "The workspace SSH execution target is not configured.",
        { details: { workspaceId: workspace.id } },
      );
    }
    return {
      kind: "ssh",
      hostRef: host,
      binding,
      targetKey: binding.targetKey,
      target: {
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
      },
    };
  }

  const server = await getSshServerConfig(host.serverId);
  if (!server) {
    throw new DomainError(
      "ssh_server_not_found",
      "The workspace SSH server is no longer registered.",
      { details: { serverId: host.serverId } },
    );
  }
  return {
    kind: "ssh",
    hostRef: host,
    binding,
    targetKey: binding.targetKey,
    target: {
      host: server.address,
      port: server.port ?? 22,
      username: server.username.trim() || undefined,
    },
  };
}
