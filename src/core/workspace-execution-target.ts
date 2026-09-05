/**
 * Single authority for resolving a workspace's canonical execution host.
 */

import type { ExecutionHostBinding, ExecutionHostRef, Workspace } from "@/shared";
import { DomainError } from "../domain/domain-error";
import { getSshServerConfig } from "../persistence/ssh-servers";
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
  workspace: Pick<Workspace, "executionHostBinding">,
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
