/**
 * Applies signed semantic checkpoints to the local user-owned domain.
 *
 * This service deliberately uses existing persistence boundaries while
 * suppressing checkpoint generation during remote application. A remote
 * write is never allowed to create an endless replication loop.
 */

import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { Agent, AgentRun } from "@/shared/agent";
import type { Chat, Task, Workspace } from "@/shared";
import type { SshServerConfig, SshServerPublicKey, SshServerSession, SshSession } from "@/shared";
import type { MeshSshServerPayload } from "../persistence/ssh-servers";
import type {
  MeshPairingMemberRecord,
  MeshSyncCheckpointRecord,
  MeshSyncAggregateType,
  MeshConflictResolution,
} from "@/shared/mesh";
import {
  applyMeshLinkMembershipSnapshot,
  getMeshLinkById,
  getMeshLinkMembershipSnapshot,
  listMeshLinkMembers,
} from "../persistence/mesh";
import {
  advanceMeshSyncCursor,
  getMaxMeshSyncCursor,
  getMeshSyncConflict,
  recordMeshSyncConflict,
  scheduleMeshCheckpoint,
  storeReceivedMeshCheckpoint,
  updateMeshSyncConflictStatus,
} from "../persistence/mesh-sync";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { getDatabase } from "../persistence/database";
import {
  deleteWorkspace,
  getWorkspaceMeshPayload,
  getWorkspace,
  saveWorkspaceFromMesh,
  type MeshWorkspacePayload,
} from "../persistence/workspaces";
import {
  deleteTask,
  loadTaskForUser,
  saveTask,
} from "../persistence/tasks";
import {
  deleteChat,
  loadChat,
  saveChat,
} from "../persistence/chats";
import {
  deleteAgent,
  deleteAgentRun,
  loadAgent,
  loadAgentRun,
  saveAgent,
  saveAgentRun,
} from "../persistence/agents";
import {
  deleteSshServer,
  deleteSshServerSession,
  getSshServerMeshPayload,
  getSshServerConfig,
  getSshServerSession,
  saveSshServerFromMesh,
  saveSshServerSession,
} from "../persistence/ssh-servers";
import {
  deleteSshSession,
  getSshSession,
  saveSshSession,
} from "../persistence/ssh-sessions";
import {
  deleteReviewCommentFromMesh,
  saveReviewCommentFromMesh,
  type MeshReviewComment,
} from "../persistence/review-comments";
import { runWithCurrentUser } from "./user-context";
import { runWithMeshReplicationSuppressed } from "./mesh-sync-context";

interface JsonObject {
  [key: string]: unknown;
}

interface MergeResult {
  value: unknown;
  conflicts: string[];
}

export interface MeshCheckpointApplyResult {
  appliedRevision: number;
  conflict: boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}

function parseMeshMembershipSnapshot(value: unknown): MeshPairingMemberRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Mesh membership checkpoint payload must be an array.");
  }
  return value.map((candidate) => {
    if (!isJsonObject(candidate)
      || typeof candidate["nodeId"] !== "string"
      || typeof candidate["localUserId"] !== "string"
      || (candidate["endpoint"] !== null && typeof candidate["endpoint"] !== "string")
      || !["https", "http"].includes(String(candidate["transport"]))
      || !["pending", "active", "offline", "revoked", "rejoining"].includes(String(candidate["status"]))
      || typeof candidate["membershipGeneration"] !== "number"
      || !Number.isInteger(candidate["membershipGeneration"])
      || typeof candidate["publicKey"] !== "string"
      || typeof candidate["fingerprint"] !== "string"
    ) {
      throw new Error("Mesh membership checkpoint contains an invalid member.");
    }
    return candidate as unknown as MeshPairingMemberRecord;
  });
}

function isMeshWorkspacePayload(value: unknown): value is MeshWorkspacePayload {
  if (!isJsonObject(value) || !isJsonObject(value["workspace"]) || !isJsonObject(value["identityFile"])) {
    return false;
  }
  const identityFile = value["identityFile"];
  return typeof identityFile["configured"] === "boolean";
}

async function parseMeshWorkspacePayload(value: unknown): Promise<MeshWorkspacePayload> {
  if (isMeshWorkspacePayload(value)) {
    return {
      workspace: workspaceWithoutIdentityFileForLegacyPayload(value["workspace"] as unknown as Workspace),
      identityFile: {
        configured: value["identityFile"]["configured"] as boolean,
      },
    };
  }
  if (!isJsonObject(value) || typeof value["id"] !== "string") {
    throw new Error("Workspace checkpoint payload has an invalid shape.");
  }
  const workspace = value as unknown as Workspace;
  return {
    workspace: workspaceWithoutIdentityFileForLegacyPayload(workspace),
    identityFile: workspace.serverSettings.agent.transport === "ssh" && workspace.serverSettings.agent.identityFile
      ? { configured: true }
      : { configured: false },
  };
}

function workspaceWithoutIdentityFileForLegacyPayload(workspace: Workspace): Workspace {
  if (workspace.serverSettings.agent.transport !== "ssh") {
    return workspace;
  }
  const { identityFile: _identityFile, ...agent } = workspace.serverSettings.agent;
  return {
    ...workspace,
    serverSettings: { agent },
  };
}

function parseMeshSshServerPayload(value: unknown): MeshSshServerPayload {
  if (!isJsonObject(value)
    || !isJsonObject(value["config"])
  ) {
    throw new Error("SSH server checkpoint payload has an invalid shape.");
  }
  const config = value["config"];
  const publicKey = isJsonObject(value["publicKey"])
    ? value["publicKey"]
    : value["keyPair"];
  if (
    typeof config["id"] !== "string"
    || !isJsonObject(publicKey)
    || publicKey["algorithm"] !== "RSA-OAEP-256"
    || typeof publicKey["publicKey"] !== "string"
    || typeof publicKey["fingerprint"] !== "string"
    || typeof publicKey["version"] !== "number"
    || !Number.isInteger(publicKey["version"])
    || typeof publicKey["createdAt"] !== "string"
  ) {
    throw new Error("SSH server checkpoint payload contains invalid public key metadata.");
  }
  return {
    config: config as unknown as SshServerConfig,
    publicKey: publicKey as unknown as SshServerPublicKey,
  };
}

function mergeThreeWay(base: unknown, local: unknown, remote: unknown, path = "$"): MergeResult {
  if (jsonEqual(local, base)) {
    return { value: remote, conflicts: [] };
  }
  if (jsonEqual(remote, base) || jsonEqual(local, remote)) {
    return { value: local, conflicts: [] };
  }
  if (isJsonObject(base) && isJsonObject(local) && isJsonObject(remote)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const merged: JsonObject = {};
    const conflicts: string[] = [];
    for (const key of [...keys].sort()) {
      const result = mergeThreeWay(
        base[key],
        local[key],
        remote[key],
        `${path}.${key}`,
      );
      merged[key] = result.value;
      conflicts.push(...result.conflicts);
    }
    return { value: merged, conflicts };
  }
  return { value: local, conflicts: [path] };
}

function toCurrentUser(row: {
  id: string;
  username: string;
  role: string;
}): CurrentUser {
  const role = row.role as CurrentUser["role"];
  return {
    id: row.id,
    username: row.username,
    role,
    isOwner: role === "owner",
    isAdmin: role === "owner" || role === "admin",
  };
}

async function getMeshUser(linkId: string): Promise<CurrentUser> {
  const link = await getMeshLinkById(linkId);
  if (!link) {
    throw new Error(`Mesh link not found: ${linkId}`);
  }
  const row = getDatabase().query(`
    SELECT id, username, role
    FROM webapp_users
    WHERE id = ?
  `).get(link.localUserId) as { id: string; username: string; role: string } | null;
  if (!row) {
    throw new Error(`Local mesh user not found: ${link.localUserId}`);
  }
  return toCurrentUser(row);
}

async function loadAggregate(
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  userId: string,
): Promise<unknown | null> {
  switch (aggregateType) {
    case "mesh_membership":
      return getMeshLinkMembershipSnapshot(aggregateId);
    case "workspace":
      {
        const workspace = await getWorkspace(aggregateId);
        return workspace ? getWorkspaceMeshPayload(workspace) : null;
      }
    case "task":
      return loadTaskForUser(aggregateId, userId);
    case "chat":
      return loadChat(aggregateId);
    case "agent":
      return loadAgent(aggregateId);
    case "agent_run":
      return loadAgentRun(aggregateId);
    case "ssh_server": {
      const config = await getSshServerConfig(aggregateId);
      return config ? getSshServerMeshPayload(config) : null;
    }
    case "ssh_server_session":
      return getSshServerSession(aggregateId);
    case "ssh_session":
      return getSshSession(aggregateId);
    case "review_comment": {
      const row = getDatabase().query(`
        SELECT id, task_id, review_cycle, comment_text, created_at, status, addressed_at
        FROM review_comments
        WHERE id = ? AND user_id = ?
      `).get(aggregateId, userId) as {
        id: string;
        task_id: string;
        review_cycle: number;
        comment_text: string;
        created_at: string;
        status: string;
        addressed_at: string | null;
      } | null;
      return row ? {
        id: row.id,
        taskId: row.task_id,
        reviewCycle: row.review_cycle,
        commentText: row.comment_text,
        createdAt: row.created_at,
        status: row.status,
        addressedAt: row.addressed_at,
      } : null;
    }
  }
}

async function applyAggregate(
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  payload: unknown,
  tombstone: boolean,
): Promise<void> {
  if (tombstone) {
    switch (aggregateType) {
      case "mesh_membership":
        throw new Error("Mesh membership checkpoints cannot be tombstones.");
      case "workspace":
        if (await getWorkspace(aggregateId) && !await deleteWorkspace(aggregateId)) {
          throw new Error(`Remote workspace deletion could not be applied: ${aggregateId}`);
        }
        return;
      case "task":
        await deleteTask(aggregateId);
        return;
      case "chat":
        await deleteChat(aggregateId);
        return;
      case "agent":
        await deleteAgent(aggregateId);
        return;
      case "agent_run":
        await deleteAgentRun(aggregateId);
        return;
      case "ssh_server":
        await deleteSshServer(aggregateId);
        return;
      case "ssh_server_session":
        await deleteSshServerSession(aggregateId);
        return;
      case "ssh_session":
        await deleteSshSession(aggregateId);
        return;
      case "review_comment":
        deleteReviewCommentFromMesh(aggregateId);
        return;
    }
  }
  if (payload === null || payload === undefined) {
    throw new Error(`Mesh checkpoint has no payload: ${aggregateType}/${aggregateId}`);
  }
  switch (aggregateType) {
    case "mesh_membership":
      await applyMeshLinkMembershipSnapshot(
        aggregateId,
        parseMeshMembershipSnapshot(payload),
      );
      return;
    case "workspace":
      await saveWorkspaceFromMesh(await parseMeshWorkspacePayload(payload));
      return;
    case "task":
      await saveTask(payload as Task);
      return;
    case "chat":
      await saveChat(payload as Chat);
      return;
    case "agent":
      await saveAgent(payload as Agent);
      return;
    case "agent_run":
      await saveAgentRun(payload as AgentRun);
      return;
    case "ssh_server":
      await saveSshServerFromMesh(parseMeshSshServerPayload(payload));
      return;
    case "ssh_server_session":
      await saveSshServerSession(payload as SshServerSession);
      return;
    case "ssh_session":
      await saveSshSession(payload as SshSession);
      return;
    case "review_comment":
      saveReviewCommentFromMesh(payload as MeshReviewComment);
      return;
  }
}

/**
 * Apply one checkpoint and advance its sender cursor exactly once.
 */
export async function applyMeshCheckpoint(
  peerNodeId: string,
  checkpoint: MeshSyncCheckpointRecord,
): Promise<MeshCheckpointApplyResult> {
  const link = await getMeshLinkById(checkpoint.linkId);
  if (!link) {
    throw new Error(`Mesh link not found for checkpoint: ${checkpoint.linkId}`);
  }
  const members = await listMeshLinkMembers(checkpoint.linkId);
  if (!members.some((member) => member.nodeId === checkpoint.originNodeId && member.status !== "revoked")) {
    throw new Error(`Mesh checkpoint origin is not a member of link: ${checkpoint.originNodeId}`);
  }
  const currentCursor = await getMaxMeshSyncCursor(
    checkpoint.aggregateType,
    checkpoint.aggregateId,
    checkpoint.originNodeId,
  );
  if (checkpoint.targetRevision <= currentCursor) {
    return { appliedRevision: currentCursor, conflict: false };
  }

  const user = await getMeshUser(checkpoint.linkId);
  const current = await runWithCurrentUser(user, () => loadAggregate(
    checkpoint.aggregateType,
    checkpoint.aggregateId,
    user.id,
  ));
  const localIdentity = await ensureLocalMeshNodeIdentity();
  const basePayload = checkpoint.aggregateType === "workspace"
    ? checkpoint.basePayload === null
      ? null
      : await parseMeshWorkspacePayload(checkpoint.basePayload)
    : checkpoint.aggregateType === "ssh_server"
      ? checkpoint.basePayload === null
        ? null
        : parseMeshSshServerPayload(checkpoint.basePayload)
      : checkpoint.basePayload;
  const remote = checkpoint.tombstone
    ? null
    : checkpoint.aggregateType === "workspace"
      ? await parseMeshWorkspacePayload(checkpoint.payload)
      : checkpoint.aggregateType === "ssh_server"
        ? parseMeshSshServerPayload(checkpoint.payload)
        : checkpoint.payload;
  const normalizedCheckpoint = checkpoint.aggregateType === "workspace"
    || checkpoint.aggregateType === "ssh_server"
    ? {
      ...checkpoint,
      basePayload,
      payload: checkpoint.tombstone ? null : remote,
    }
    : checkpoint;

  if (checkpoint.aggregateType === "mesh_membership") {
    if (checkpoint.tombstone || remote === null) {
      throw new Error("Mesh membership checkpoints cannot be tombstones.");
    }
    await runWithCurrentUser(user, () => runWithMeshReplicationSuppressed(
      () => applyAggregate(
        checkpoint.aggregateType,
        checkpoint.aggregateId,
        remote,
        false,
      ),
    ));
    await storeReceivedMeshCheckpoint({ peerNodeId, checkpoint: normalizedCheckpoint });
    await advanceMeshSyncCursor(
      peerNodeId,
      checkpoint.aggregateType,
      checkpoint.aggregateId,
      checkpoint.originNodeId,
      checkpoint.targetRevision,
    );
    return { appliedRevision: checkpoint.targetRevision, conflict: false };
  }

  let merged = remote;
  let conflicts: string[] = [];
  if (current !== null && current !== undefined) {
    const remoteIsActiveAuthority = link.activeNodeId === checkpoint.originNodeId
      && checkpoint.originNodeId !== localIdentity.nodeId;
    if (remoteIsActiveAuthority) {
      merged = remote;
    } else if (checkpoint.tombstone) {
      if (jsonEqual(current, basePayload)) {
        merged = null;
      } else {
        conflicts = ["$"];
      }
    } else {
      const result = mergeThreeWay(basePayload, current, remote);
      merged = result.value;
      conflicts = result.conflicts;
    }
  }

  if (conflicts.length > 0) {
    await recordMeshSyncConflict({
      linkId: checkpoint.linkId,
      aggregateType: checkpoint.aggregateType,
      aggregateId: checkpoint.aggregateId,
      originNodeId: checkpoint.originNodeId,
      remoteRevision: checkpoint.targetRevision,
      basePayload,
      localPayload: current,
      remotePayload: remote,
    });
    await storeReceivedMeshCheckpoint({ peerNodeId, checkpoint: normalizedCheckpoint });
    await advanceMeshSyncCursor(
      peerNodeId,
      checkpoint.aggregateType,
      checkpoint.aggregateId,
      checkpoint.originNodeId,
      checkpoint.targetRevision,
    );
    return { appliedRevision: checkpoint.targetRevision, conflict: true };
  }

  const changed = !jsonEqual(current, merged);
  if (changed) {
    await runWithCurrentUser(user, () => runWithMeshReplicationSuppressed(
      () => applyAggregate(
        checkpoint.aggregateType,
        checkpoint.aggregateId,
        merged,
        checkpoint.tombstone && merged === null,
      ),
    ));
  }
  await storeReceivedMeshCheckpoint({ peerNodeId, checkpoint: normalizedCheckpoint });
  await advanceMeshSyncCursor(
    peerNodeId,
    checkpoint.aggregateType,
    checkpoint.aggregateId,
    checkpoint.originNodeId,
    checkpoint.targetRevision,
  );
  if (changed && !jsonEqual(merged, remote) && merged !== null) {
    scheduleMeshCheckpoint({
      userId: user.id,
      aggregateType: checkpoint.aggregateType,
      aggregateId: checkpoint.aggregateId,
      payload: merged,
      eligible: true,
    });
  }
  return { appliedRevision: checkpoint.targetRevision, conflict: false };
}

export async function resolveMeshSyncConflict(
  localUserId: string,
  conflictId: string,
  resolution: MeshConflictResolution,
): Promise<ReturnType<typeof updateMeshSyncConflictStatus> extends Promise<infer T> ? T : never> {
  const conflict = await getMeshSyncConflict(conflictId);
  if (!conflict) {
    throw new Error(`Mesh sync conflict was not found: ${conflictId}`);
  }
  const link = await getMeshLinkById(conflict.linkId);
  if (!link || link.localUserId !== localUserId) {
    throw new Error("Mesh sync conflict is not owned by this user.");
  }
  if (conflict.status !== "open") {
    throw new Error("Mesh sync conflict is no longer open.");
  }

  if (resolution !== "dismiss") {
    const user = await getMeshUser(conflict.linkId);
    const chosen = resolution === "remote" ? conflict.remotePayload : conflict.localPayload;
    await runWithCurrentUser(user, () => runWithMeshReplicationSuppressed(
      () => applyAggregate(
        conflict.aggregateType,
        conflict.aggregateId,
        chosen,
        chosen === null,
      ),
    ));
    scheduleMeshCheckpoint({
      userId: user.id,
      aggregateType: conflict.aggregateType,
      aggregateId: conflict.aggregateId,
      payload: chosen ?? undefined,
      tombstone: chosen === null,
      eligible: true,
    });
  }
  return await updateMeshSyncConflictStatus(
    conflictId,
    resolution === "dismiss" ? "dismissed" : "resolved",
  );
}
