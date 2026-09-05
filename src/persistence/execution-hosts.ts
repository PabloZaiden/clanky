/**
 * Owner-scoped persistence for canonical execution-host identities.
 */

import type {
  ExecutionHostBinding,
  ExecutionHostKind,
  ExecutionHostRef,
} from "@/shared";
import {
  getExecutionHostSourceId,
} from "@/shared";
import { getDatabase } from "./database";

export interface PersistedExecutionHost {
  id: string;
  userId: string;
  ref: ExecutionHostRef;
  targetKey: string;
  revision: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExecutionHostRow {
  id: string;
  user_id: string;
  kind: ExecutionHostKind;
  source_id: string;
  target_key: string;
  revision: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function refFromParts(kind: ExecutionHostKind, sourceId: string): ExecutionHostRef {
  if (kind === "ssh") {
    return { kind, serverId: sourceId };
  }
  return { kind, nodeId: sourceId };
}

function rowToExecutionHost(row: ExecutionHostRow): PersistedExecutionHost {
  return {
    id: row.id,
    userId: row.user_id,
    ref: refFromParts(row.kind, row.source_id),
    targetKey: row.target_key,
    revision: Math.max(1, Math.floor(row.revision)),
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectExecutionHost(
  whereClause: string,
  values: Array<string>,
): PersistedExecutionHost | null {
  const row = getDatabase().query(`
    SELECT
      id, user_id, kind, source_id, target_key, revision,
      revoked_at, created_at, updated_at
    FROM execution_hosts
    WHERE ${whereClause}
    ORDER BY revoked_at IS NULL DESC, created_at DESC
    LIMIT 1
  `).get(...values) as ExecutionHostRow | null;
  return row ? rowToExecutionHost(row) : null;
}

export function getExecutionHostById(
  userId: string,
  hostId: string,
): PersistedExecutionHost | null {
  return selectExecutionHost("id = ? AND user_id = ?", [hostId, userId]);
}

export function getExecutionHostByRef(
  userId: string,
  ref: ExecutionHostRef,
): PersistedExecutionHost | null {
  return selectExecutionHost(
    "user_id = ? AND kind = ? AND source_id = ?",
    [userId, ref.kind, getExecutionHostSourceId(ref)],
  );
}

export function getExecutionHostByTargetKey(
  userId: string,
  targetKey: string,
): PersistedExecutionHost | null {
  return selectExecutionHost(
    "user_id = ? AND target_key = ?",
    [userId, targetKey],
  );
}

export function listExecutionHosts(userId: string): PersistedExecutionHost[] {
  const rows = getDatabase().query(`
    SELECT
      id, user_id, kind, source_id, target_key, revision,
      revoked_at, created_at, updated_at
    FROM execution_hosts
    WHERE user_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(userId) as ExecutionHostRow[];
  return rows.map(rowToExecutionHost);
}

export function ensureExecutionHost(
  userId: string,
  ref: ExecutionHostRef,
  targetKey: string,
): PersistedExecutionHost {
  const db = getDatabase();
  const sourceId = getExecutionHostSourceId(ref);
  const existing = getExecutionHostByRef(userId, ref);
  if (existing) {
    if (existing.targetKey === targetKey && existing.revokedAt === null) {
      return existing;
    }
    const updatedAt = new Date().toISOString();
    db.query(`
      UPDATE execution_hosts
      SET target_key = ?, revoked_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(targetKey, updatedAt, existing.id, userId);
    return getExecutionHostById(userId, existing.id)!;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO execution_hosts (
      id, user_id, kind, source_id, target_key, revision,
      revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(id, userId, ref.kind, sourceId, targetKey, now, now);
  return getExecutionHostById(userId, id)!;
}

export function resolveExecutionHostBindingId(
  userId: string,
  binding: ExecutionHostBinding,
): string {
  const host = getExecutionHostByRef(userId, binding.host);
  if (!host) {
    throw new Error(
      `Execution host is not registered: ${binding.host.kind}:${getExecutionHostSourceId(binding.host)}`,
    );
  }
  return host.id;
}

export function toExecutionHostBinding(
  host: PersistedExecutionHost,
): ExecutionHostBinding {
  return {
    host: host.ref,
    targetKey: host.targetKey,
    revision: host.revision,
  };
}

export function revokeExecutionHost(userId: string, hostId: string): boolean {
  const now = new Date().toISOString();
  const result = getDatabase().query(`
    UPDATE execution_hosts
    SET revoked_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(now, now, hostId, userId);
  return result.changes > 0;
}

export function executionHostBindingFromRow(
  row: Record<string, unknown>,
): ExecutionHostBinding | null {
  const kind = row["execution_host_kind"];
  const sourceId = row["execution_host_source_id"];
  const targetKey = row["execution_host_target_key"];
  const revision = row["execution_host_revision"];
  if (
    (kind !== "local" && kind !== "mesh" && kind !== "ssh")
    || typeof sourceId !== "string"
    || typeof targetKey !== "string"
    || typeof revision !== "number"
  ) {
    return null;
  }
  return {
    host: refFromParts(kind, sourceId),
    targetKey,
    revision: Math.max(1, Math.floor(revision)),
  };
}

export const EXECUTION_HOST_JOIN_COLUMNS = `
  execution_host.kind AS execution_host_kind,
  execution_host.source_id AS execution_host_source_id,
  execution_host.target_key AS execution_host_target_key
`;
