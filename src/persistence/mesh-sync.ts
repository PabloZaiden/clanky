/**
 * Persistence for semantic mesh checkpoints, cursors, conflicts, and outbox
 * delivery. Domain modules call scheduleMeshCheckpoint after local writes;
 * transport workers use the remaining functions to deliver and acknowledge
 * those checkpoints.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshSyncAggregateType,
  MeshSyncCheckpointRecord,
  MeshSyncConflictRecord,
  MeshSyncConflictStatus,
  MeshSyncOutboxRecord,
  MeshSyncOutboxStatus,
} from "@/shared/mesh";
import {
  getMeshLinkMembershipSnapshot,
  getMeshLinkForLocalUser,
  getMeshNode,
  listMeshLinkMembers,
} from "./mesh";
import { getDatabase } from "./database";
import { ensureLocalMeshNodeIdentity } from "./mesh-node-identity";
import { isMeshReplicationSuppressed } from "../core/mesh-sync-context";

const log = createLogger("persistence:mesh-sync");

interface MeshSyncCheckpointRow {
  checkpoint_id: string;
  link_id: string;
  aggregate_type: MeshSyncAggregateType;
  aggregate_id: string;
  origin_node_id: string;
  base_revision: number;
  target_revision: number;
  base_payload: string | null;
  payload: string | null;
  tombstone: number;
  created_at: string;
}

interface MeshSyncOutboxRow {
  peer_node_id: string;
  checkpoint_id: string;
  link_id: string;
  aggregate_type: MeshSyncAggregateType;
  aggregate_id: string;
  origin_node_id: string;
  target_revision: number;
  status: MeshSyncOutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface MeshSyncConflictRow {
  conflict_id: string;
  link_id: string;
  aggregate_type: MeshSyncAggregateType;
  aggregate_id: string;
  origin_node_id: string;
  remote_revision: number;
  base_payload: string | null;
  local_payload: string | null;
  remote_payload: string | null;
  status: MeshSyncConflictStatus;
  created_at: string;
  updated_at: string;
}

export interface RecordMeshCheckpointInput {
  userId: string;
  aggregateType: MeshSyncAggregateType;
  aggregateId: string;
  payload?: unknown;
  tombstone?: boolean;
  eligible?: boolean;
  includeRevokedPeers?: boolean;
}

export interface StoreReceivedCheckpointInput {
  peerNodeId: string;
  checkpoint: MeshSyncCheckpointRecord;
}

function parsePayload(value: string | null): unknown {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    log.error("Mesh checkpoint payload is invalid JSON", { error: String(error) });
    throw new Error("Mesh checkpoint payload is invalid JSON.", { cause: error });
  }
}

function serializePayload(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error("Mesh checkpoint payload could not be serialized.", { cause: error });
  }
}

function checkpointFromRow(row: MeshSyncCheckpointRow): MeshSyncCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    linkId: row.link_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    originNodeId: row.origin_node_id,
    baseRevision: row.base_revision,
    targetRevision: row.target_revision,
    basePayload: parsePayload(row.base_payload),
    payload: parsePayload(row.payload),
    tombstone: row.tombstone === 1,
    createdAt: row.created_at,
  };
}

function outboxFromRow(row: MeshSyncOutboxRow): MeshSyncOutboxRecord {
  return {
    peerNodeId: row.peer_node_id,
    checkpointId: row.checkpoint_id,
    linkId: row.link_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    originNodeId: row.origin_node_id,
    targetRevision: row.target_revision,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conflictFromRow(row: MeshSyncConflictRow): MeshSyncConflictRecord {
  return {
    conflictId: row.conflict_id,
    linkId: row.link_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    originNodeId: row.origin_node_id,
    remoteRevision: row.remote_revision,
    basePayload: parsePayload(row.base_payload),
    localPayload: parsePayload(row.local_payload),
    remotePayload: parsePayload(row.remote_payload),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getWorkspaceTransport(userId: string, workspaceId: string): "stdio" | "ssh" | null {
  const row = getDatabase().query(`
    SELECT server_settings
    FROM workspaces
    WHERE id = ? AND user_id = ?
  `).get(workspaceId, userId) as { server_settings?: string } | null;
  if (!row?.server_settings) {
    return null;
  }
  try {
    const settings = JSON.parse(row.server_settings) as Record<string, unknown>;
    const agent = settings["agent"];
    if (typeof agent !== "object" || agent === null) {
      return null;
    }
    const transport = (agent as Record<string, unknown>)["transport"];
    return transport === "stdio" || transport === "ssh" ? transport : null;
  } catch (error) {
    log.warn("Skipping mesh eligibility for invalid workspace settings", {
      workspaceId,
      error: String(error),
    });
    return null;
  }
}

function isSshWorkspace(userId: string, workspaceId: string): boolean {
  return getWorkspaceTransport(userId, workspaceId) === "ssh";
}

/**
 * Workspace descriptors are portable for both execution transports. The
 * execution-bound aggregates below intentionally remain SSH-only: an SSH
 * workspace points at a shared remote host, while stdio execution is owned by
 * the originating node and must not be replayed on another node.
 */
function isWorkspaceDescriptorEligible(userId: string, workspaceId: string): boolean {
  return getWorkspaceTransport(userId, workspaceId) !== null;
}

export function isMeshAggregateEligible(
  userId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
): boolean {
  const db = getDatabase();
  switch (aggregateType) {
    case "mesh_membership":
      return db.query("SELECT 1 FROM mesh_links WHERE link_id = ? AND local_user_id = ?")
        .get(aggregateId, userId) !== null;
    case "workspace": {
      return isWorkspaceDescriptorEligible(userId, aggregateId);
    }
    case "ssh_server":
      return db.query("SELECT 1 FROM ssh_servers WHERE id = ? AND user_id = ?")
        .get(aggregateId, userId) !== null;
    case "ssh_server_session":
      return db.query(`
        SELECT 1
        FROM ssh_server_sessions AS session
        JOIN ssh_servers AS server ON server.id = session.ssh_server_id
        WHERE session.id = ? AND session.user_id = ? AND server.user_id = ?
      `).get(aggregateId, userId, userId) !== null;
    case "ssh_session":
      {
        const row = db.query(`
        SELECT workspace_id
        FROM ssh_sessions
        WHERE id = ? AND user_id = ?
        `).get(aggregateId, userId) as { workspace_id: string | null } | null;
        return row?.workspace_id ? isSshWorkspace(userId, row.workspace_id) : false;
      }
    case "task": {
      const row = db.query("SELECT workspace_id FROM tasks WHERE id = ? AND user_id = ?")
        .get(aggregateId, userId) as { workspace_id: string | null } | null;
      return row?.workspace_id ? isSshWorkspace(userId, row.workspace_id) : false;
    }
    case "chat": {
      const row = db.query(`
        SELECT source_kind, workspace_id, ssh_server_id
        FROM chats
        WHERE id = ? AND user_id = ?
      `).get(aggregateId, userId) as {
        source_kind: string;
        workspace_id: string | null;
        ssh_server_id: string | null;
      } | null;
      return row?.source_kind === "ssh_server"
        ? row.ssh_server_id !== null
        : row?.workspace_id
          ? isSshWorkspace(userId, row.workspace_id)
          : false;
    }
    case "agent": {
      const row = db.query("SELECT workspace_id FROM agents WHERE id = ? AND user_id = ?")
        .get(aggregateId, userId) as { workspace_id: string } | null;
      return row ? isSshWorkspace(userId, row.workspace_id) : false;
    }
    case "agent_run": {
      const row = db.query(`
        SELECT agent.workspace_id
        FROM agent_runs AS run
        JOIN agents AS agent ON agent.id = run.agent_id
        WHERE run.id = ? AND run.user_id = ? AND agent.user_id = ?
      `).get(aggregateId, userId, userId) as { workspace_id: string } | null;
      return row ? isSshWorkspace(userId, row.workspace_id) : false;
    }
    case "review_comment": {
      const row = db.query(`
        SELECT task.workspace_id
        FROM review_comments AS comment
        JOIN tasks AS task ON task.id = comment.task_id
        WHERE comment.id = ? AND comment.user_id = ? AND task.user_id = ?
      `).get(aggregateId, userId, userId) as { workspace_id: string | null } | null;
      return row?.workspace_id ? isSshWorkspace(userId, row.workspace_id) : false;
    }
  }
}

async function getLatestAggregateCheckpoint(
  originNodeId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
): Promise<MeshSyncCheckpointRecord | null> {
  const row = getDatabase().query(`
    SELECT checkpoint_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      base_revision, target_revision, base_payload, payload, tombstone, created_at
    FROM mesh_sync_checkpoints
    WHERE origin_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
    ORDER BY target_revision DESC
    LIMIT 1
  `).get(originNodeId, aggregateType, aggregateId) as MeshSyncCheckpointRow | null;
  return row ? checkpointFromRow(row) : null;
}

async function getLatestMaterializedCheckpoint(
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
): Promise<MeshSyncCheckpointRecord | null> {
  const row = getDatabase().query(`
    SELECT checkpoint_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      base_revision, target_revision, base_payload, payload, tombstone, created_at
    FROM mesh_sync_checkpoints
    WHERE aggregate_type = ? AND aggregate_id = ?
    ORDER BY created_at DESC, target_revision DESC
    LIMIT 1
  `).get(aggregateType, aggregateId) as MeshSyncCheckpointRow | null;
  return row ? checkpointFromRow(row) : null;
}

/**
 * Record a local semantic change and fan it out to every known non-revoked
 * member. The operation is intentionally local-only; delivery is worker-owned.
 */
export async function recordMeshCheckpoint(
  input: RecordMeshCheckpointInput,
): Promise<MeshSyncCheckpointRecord | null> {
  if (isMeshReplicationSuppressed()) {
    return null;
  }
  if (input.eligible !== true && !isMeshAggregateEligible(input.userId, input.aggregateType, input.aggregateId)) {
    return null;
  }
  const link = await getMeshLinkForLocalUser(input.userId);
  if (!link) {
    return null;
  }
  const identity = await ensureLocalMeshNodeIdentity();
  const previous = await getLatestAggregateCheckpoint(
    identity.nodeId,
    input.aggregateType,
    input.aggregateId,
  );
  const materialized = await getLatestMaterializedCheckpoint(input.aggregateType, input.aggregateId);
  const now = new Date().toISOString();
  const checkpoint: MeshSyncCheckpointRecord = {
    checkpointId: crypto.randomUUID(),
    linkId: link.linkId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    originNodeId: identity.nodeId,
    baseRevision: previous?.targetRevision ?? 0,
    targetRevision: (previous?.targetRevision ?? 0) + 1,
    basePayload: materialized?.payload ?? previous?.payload ?? null,
    payload: input.tombstone ? null : input.payload ?? null,
    tombstone: input.tombstone === true,
    createdAt: now,
  };
  const db = getDatabase();
  const members = await listMeshLinkMembers(link.linkId);
  const transaction = db.transaction(() => {
    db.run(`
      INSERT INTO mesh_sync_checkpoints (
        checkpoint_id, link_id, aggregate_type, aggregate_id, origin_node_id,
        base_revision, target_revision, base_payload, payload, tombstone, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      checkpoint.checkpointId,
      checkpoint.linkId,
      checkpoint.aggregateType,
      checkpoint.aggregateId,
      checkpoint.originNodeId,
      checkpoint.baseRevision,
      checkpoint.targetRevision,
      serializePayload(checkpoint.basePayload),
      serializePayload(checkpoint.payload),
      checkpoint.tombstone ? 1 : 0,
      checkpoint.createdAt,
    ]);
    for (const member of members) {
      if (
        member.nodeId === identity.nodeId
        || (member.status === "revoked" && input.includeRevokedPeers !== true)
      ) {
        continue;
      }
      db.run(`
        INSERT INTO mesh_sync_outbox (
          peer_node_id, checkpoint_id, link_id, aggregate_type, aggregate_id,
          origin_node_id, target_revision, status, attempts, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(peer_node_id, aggregate_type, aggregate_id, origin_node_id)
        DO UPDATE SET
          checkpoint_id = excluded.checkpoint_id,
          target_revision = excluded.target_revision,
          status = 'pending',
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `, [
        member.nodeId,
        checkpoint.checkpointId,
        checkpoint.linkId,
        checkpoint.aggregateType,
        checkpoint.aggregateId,
        checkpoint.originNodeId,
        checkpoint.targetRevision,
        now,
        now,
        now,
      ]);
    }
  });
  transaction();
  return checkpoint;
}

export async function recordMeshMembershipCheckpoint(
  userId: string,
  options: { includeRevokedPeers?: boolean } = {},
): Promise<MeshSyncCheckpointRecord | null> {
  const link = await getMeshLinkForLocalUser(userId);
  if (!link) {
    return null;
  }
  return await recordMeshCheckpoint({
    userId,
    aggregateType: "mesh_membership",
    aggregateId: link.linkId,
    payload: await getMeshLinkMembershipSnapshot(link.linkId),
    eligible: true,
    includeRevokedPeers: options.includeRevokedPeers,
  });
}

export function scheduleMeshCheckpoint(input: RecordMeshCheckpointInput): void {
  if (isMeshReplicationSuppressed()) {
    return;
  }
  queueMicrotask(() => {
    void recordMeshCheckpoint(input).catch((error) => {
      log.error("Failed to record mesh checkpoint", {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        error: String(error),
      });
    });
  });
}

export async function getMeshSyncCheckpoint(checkpointId: string): Promise<MeshSyncCheckpointRecord | null> {
  const row = getDatabase().query(`
    SELECT checkpoint_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      base_revision, target_revision, base_payload, payload, tombstone, created_at
    FROM mesh_sync_checkpoints
    WHERE checkpoint_id = ?
  `).get(checkpointId) as MeshSyncCheckpointRow | null;
  return row ? checkpointFromRow(row) : null;
}

export async function storeReceivedMeshCheckpoint(
  input: StoreReceivedCheckpointInput,
): Promise<MeshSyncCheckpointRecord> {
  const existing = await getMeshSyncCheckpoint(input.checkpoint.checkpointId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(input.checkpoint)) {
      throw new Error(`Mesh checkpoint conflict: ${input.checkpoint.checkpointId}`);
    }
    return existing;
  }
  const checkpoint = input.checkpoint;
  const members = await listMeshLinkMembers(checkpoint.linkId);
  const db = getDatabase();
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.run(`
      INSERT INTO mesh_sync_checkpoints (
        checkpoint_id, link_id, aggregate_type, aggregate_id, origin_node_id,
        base_revision, target_revision, base_payload, payload, tombstone, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      checkpoint.checkpointId,
      checkpoint.linkId,
      checkpoint.aggregateType,
      checkpoint.aggregateId,
      checkpoint.originNodeId,
      checkpoint.baseRevision,
      checkpoint.targetRevision,
      serializePayload(checkpoint.basePayload),
      serializePayload(checkpoint.payload),
      checkpoint.tombstone ? 1 : 0,
      checkpoint.createdAt,
    ]);
    for (const member of members) {
      if (member.nodeId === input.peerNodeId || member.status === "revoked") {
        continue;
      }
      db.run(`
        INSERT INTO mesh_sync_outbox (
          peer_node_id, checkpoint_id, link_id, aggregate_type, aggregate_id,
          origin_node_id, target_revision, status, attempts, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(peer_node_id, aggregate_type, aggregate_id, origin_node_id)
        DO UPDATE SET
          checkpoint_id = excluded.checkpoint_id,
          target_revision = excluded.target_revision,
          status = 'pending',
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL,
          updated_at = excluded.updated_at
      `, [
        member.nodeId,
        checkpoint.checkpointId,
        checkpoint.linkId,
        checkpoint.aggregateType,
        checkpoint.aggregateId,
        checkpoint.originNodeId,
        checkpoint.targetRevision,
        now,
        now,
        now,
      ]);
    }
  });
  transaction();
  return checkpoint;
}

export async function claimMeshSyncOutbox(limit: number): Promise<MeshSyncOutboxRecord[]> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db.query(`
    SELECT peer_node_id, checkpoint_id, link_id, aggregate_type, aggregate_id,
      origin_node_id, target_revision, status, attempts, next_attempt_at,
      last_error, created_at, updated_at
    FROM mesh_sync_outbox
    WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT ?
  `).all(now, limit) as MeshSyncOutboxRow[];
  if (rows.length === 0) {
    return [];
  }
  const transaction = db.transaction(() => {
    for (const row of rows) {
      db.run(`
        UPDATE mesh_sync_outbox
        SET status = 'inflight', attempts = attempts + 1, updated_at = ?
        WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
          AND origin_node_id = ? AND status IN ('pending', 'failed')
      `, [now, row.peer_node_id, row.aggregate_type, row.aggregate_id, row.origin_node_id]);
    }
  });
  transaction();
  return rows.map((row) => ({ ...outboxFromRow(row), status: "inflight", attempts: row.attempts + 1 }));
}

export async function markMeshSyncOutboxRetry(
  outbox: MeshSyncOutboxRecord,
  error: string,
): Promise<void> {
  const delayMs = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.min(outbox.attempts, 10));
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  getDatabase().run(`
    UPDATE mesh_sync_outbox
    SET status = 'failed', next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ? AND origin_node_id = ?
  `, [
    nextAttemptAt,
    error.slice(0, 2_000),
    new Date().toISOString(),
    outbox.peerNodeId,
    outbox.aggregateType,
    outbox.aggregateId,
    outbox.originNodeId,
  ]);
}

export async function acknowledgeMeshSyncOutbox(
  peerNodeId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  originNodeId: string,
  appliedRevision: number,
): Promise<void> {
  getDatabase().run(`
    DELETE FROM mesh_sync_outbox
    WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
      AND origin_node_id = ? AND target_revision <= ?
  `, [peerNodeId, aggregateType, aggregateId, originNodeId, appliedRevision]);
}

export async function getMeshSyncCursor(
  peerNodeId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  originNodeId: string,
): Promise<number> {
  const row = getDatabase().query(`
    SELECT applied_revision
    FROM mesh_sync_cursors
    WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ? AND origin_node_id = ?
  `).get(peerNodeId, aggregateType, aggregateId, originNodeId) as { applied_revision: number } | null;
  return row?.applied_revision ?? 0;
}

export async function getMaxMeshSyncCursor(
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  originNodeId: string,
): Promise<number> {
  const row = getDatabase().query(`
    SELECT MAX(applied_revision) AS applied_revision
    FROM mesh_sync_cursors
    WHERE aggregate_type = ? AND aggregate_id = ? AND origin_node_id = ?
  `).get(aggregateType, aggregateId, originNodeId) as { applied_revision: number | null } | null;
  return row?.applied_revision ?? 0;
}

export async function advanceMeshSyncCursor(
  peerNodeId: string,
  aggregateType: MeshSyncAggregateType,
  aggregateId: string,
  originNodeId: string,
  appliedRevision: number,
): Promise<void> {
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO mesh_sync_cursors (
      peer_node_id, aggregate_type, aggregate_id, origin_node_id,
      applied_revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(peer_node_id, aggregate_type, aggregate_id, origin_node_id)
    DO UPDATE SET
      applied_revision = MAX(mesh_sync_cursors.applied_revision, excluded.applied_revision),
      updated_at = excluded.updated_at
  `, [peerNodeId, aggregateType, aggregateId, originNodeId, appliedRevision, now]);
}

export async function recordMeshSyncConflict(input: {
  linkId: string;
  aggregateType: MeshSyncAggregateType;
  aggregateId: string;
  originNodeId: string;
  remoteRevision: number;
  basePayload: unknown;
  localPayload: unknown;
  remotePayload: unknown;
}): Promise<MeshSyncConflictRecord> {
  const now = new Date().toISOString();
  const conflictId = crypto.randomUUID();
  getDatabase().run(`
    INSERT INTO mesh_sync_conflicts (
      conflict_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      remote_revision, base_payload, local_payload, remote_payload,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    ON CONFLICT(link_id, aggregate_type, aggregate_id, origin_node_id, remote_revision)
    DO UPDATE SET updated_at = excluded.updated_at
  `, [
    conflictId,
    input.linkId,
    input.aggregateType,
    input.aggregateId,
    input.originNodeId,
    input.remoteRevision,
    serializePayload(input.basePayload),
    serializePayload(input.localPayload),
    serializePayload(input.remotePayload),
    now,
    now,
  ]);
  const row = getDatabase().query(`
    SELECT conflict_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      remote_revision, base_payload, local_payload, remote_payload,
      status, created_at, updated_at
    FROM mesh_sync_conflicts
    WHERE link_id = ? AND aggregate_type = ? AND aggregate_id = ?
      AND origin_node_id = ? AND remote_revision = ?
  `).get(
    input.linkId,
    input.aggregateType,
    input.aggregateId,
    input.originNodeId,
    input.remoteRevision,
  ) as MeshSyncConflictRow | null;
  if (!row) {
    throw new Error(`Mesh sync conflict was not persisted: ${input.aggregateId}`);
  }
  return conflictFromRow(row);
}

export async function listOpenMeshSyncConflicts(linkId: string): Promise<MeshSyncConflictRecord[]> {
  const rows = getDatabase().query(`
    SELECT conflict_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      remote_revision, base_payload, local_payload, remote_payload,
      status, created_at, updated_at
    FROM mesh_sync_conflicts
    WHERE link_id = ? AND status = 'open'
    ORDER BY updated_at DESC
  `).all(linkId) as MeshSyncConflictRow[];
  return rows.map(conflictFromRow);
}

export async function getMeshSyncConflict(conflictId: string): Promise<MeshSyncConflictRecord | null> {
  const row = getDatabase().query(`
    SELECT conflict_id, link_id, aggregate_type, aggregate_id, origin_node_id,
      remote_revision, base_payload, local_payload, remote_payload,
      status, created_at, updated_at
    FROM mesh_sync_conflicts
    WHERE conflict_id = ?
  `).get(conflictId) as MeshSyncConflictRow | null;
  return row ? conflictFromRow(row) : null;
}

export async function updateMeshSyncConflictStatus(
  conflictId: string,
  status: Extract<MeshSyncConflictStatus, "resolved" | "dismissed">,
): Promise<MeshSyncConflictRecord> {
  getDatabase().run(`
    UPDATE mesh_sync_conflicts
    SET status = ?, updated_at = ?
    WHERE conflict_id = ? AND status = 'open'
  `, [status, new Date().toISOString(), conflictId]);
  const conflict = await getMeshSyncConflict(conflictId);
  if (!conflict) {
    throw new Error(`Mesh sync conflict was not found: ${conflictId}`);
  }
  return conflict;
}

export async function listDueMeshSyncOutbox(limit = 25): Promise<MeshSyncOutboxRecord[]> {
  return claimMeshSyncOutbox(Math.max(1, Math.min(limit, 100)));
}

export async function getMeshSyncPeerNode(peerNodeId: string) {
  return getMeshNode(peerNodeId);
}
