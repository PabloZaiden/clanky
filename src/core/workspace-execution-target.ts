/**
 * Single authority for resolving a workspace's execution host.
 *
 * Backend, executor, terminal, capability, and workspace mutation code all
 * use this resolver so local stdio, Mesh stdio, and SSH cannot drift apart.
 */

import type { ExecutionHostRef } from "@/shared/execution-host";
import type { ServerSettings } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";
import { ensureLocalInstallationId } from "../persistence/installation-identity";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import {
  buildLocalTargetKey,
  buildMeshTargetKey,
  buildSshTargetKey,
} from "../persistence/workspace-target-key";
import {
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "../persistence/mesh";
import { DomainError } from "../domain/domain-error";
import { requireCurrentUserId } from "./user-context";
import {
  getSshConnectionTargetFromSettings,
  type SshConnectionTarget,
} from "./ssh-connection-target";

export interface WorkspaceExecutionTargetInput {
  serverSettings: ServerSettings;
  executionNodeId?: string | null;
  sshServerId?: string | null;
}

export type ResolvedWorkspaceExecutionTarget =
  | {
      kind: "local";
      hostRef: ExecutionHostRef;
      targetKey: string;
      executionNodeId: string;
    }
  | {
      kind: "mesh";
      hostRef: ExecutionHostRef;
      targetKey: string;
      nodeId: string;
    }
  | {
      kind: "ssh";
      /** Null only for a legacy unregistered SSH target. */
      hostRef: ExecutionHostRef | null;
      targetKey: string;
      target: SshConnectionTarget;
    };

export interface ResolveWorkspaceExecutionTargetOptions {
  /**
   * Skip Mesh membership checks when comparing already-persisted targets.
   * The caller must still use the validating form before starting work on a
   * newly selected peer.
   */
  validateMeshTarget?: boolean;
  /** Cached local Mesh node ID supplied by backend state when available. */
  localNodeId?: string | null;
}

function sshTargetKey(target: SshConnectionTarget): string {
  return buildSshTargetKey(target.host, target.port, target.username);
}

async function assertTrustedMeshTarget(targetNodeId: string): Promise<void> {
  const link = await getMeshLinkForLocalUser(requireCurrentUserId());
  const member = link
    ? (await listMeshLinkMembers(link.linkId)).find((candidate) => candidate.nodeId === targetNodeId)
    : undefined;
  const node = await getMeshNode(targetNodeId);
  if (
    !link
    || link.status !== "active"
    || !member
    || member.status === "pending"
    || member.status === "revoked"
    || !node
    || node.status === "pending"
    || node.status === "revoked"
  ) {
    throw new DomainError(
      "workspace_execution_target_not_trusted",
      "The selected stdio execution target is not a trusted mesh peer.",
      { details: { executionNodeId: targetNodeId } },
    );
  }
}

/**
 * Resolve a workspace-like execution configuration to one stable target.
 */
export async function resolveWorkspaceExecutionTarget(
  input: WorkspaceExecutionTargetInput | Pick<
    Workspace,
    "serverSettings" | "executionNodeId" | "sshServerId"
  >,
  options: ResolveWorkspaceExecutionTargetOptions = {},
): Promise<ResolvedWorkspaceExecutionTarget> {
  const { serverSettings, executionNodeId } = input;
  const sshTarget = getSshConnectionTargetFromSettings(serverSettings);
  if (sshTarget) {
    return {
      kind: "ssh",
      hostRef: input.sshServerId
        ? { kind: "ssh", serverId: input.sshServerId }
        : null,
      targetKey: sshTargetKey(sshTarget),
      target: sshTarget,
    };
  }

  const localNodeId = options.localNodeId?.trim()
    || (await ensureLocalMeshNodeIdentity()).nodeId;
  const targetNodeId = executionNodeId?.trim() || localNodeId;
  if (targetNodeId !== localNodeId && options.validateMeshTarget !== false) {
    await assertTrustedMeshTarget(targetNodeId);
  }

  if (targetNodeId === localNodeId) {
    const installationId = await ensureLocalInstallationId();
    return {
      kind: "local",
      hostRef: { kind: "local", nodeId: targetNodeId },
      targetKey: buildLocalTargetKey(installationId),
      executionNodeId: targetNodeId,
    };
  }

  return {
    kind: "mesh",
    hostRef: { kind: "mesh", nodeId: targetNodeId },
    targetKey: buildMeshTargetKey(targetNodeId),
    nodeId: targetNodeId,
  };
}
