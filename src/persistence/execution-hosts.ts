/**
 * Owner-scoped persistence for canonical execution-host identities.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  ExecutionHostBinding,
  ExecutionHostCapabilities,
  ExecutionHostKind,
  ExecutionHostRef,
  ExecutionHostRuntimeSnapshot,
} from "@/shared";
import {
  executionHostRefFromParts,
  getExecutionHostSourceId,
  normalizeExecutionHostPlatform,
  parseExecutionHostCapabilities,
} from "@/shared";
import { getDatabase } from "./database";

const log = createLogger("persistence:execution-hosts");

export interface PersistedExecutionHost {
  id: string;
  userId: string;
  ref: ExecutionHostRef;
  targetKey: string;
  runtime: ExecutionHostRuntimeSnapshot;
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
  platform_os: string | null;
  platform_architecture: string | null;
  capabilities_json: string;
  revision: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseCapabilities(
  raw: string,
  hostId: string,
): ExecutionHostCapabilities {
  try {
    const value = JSON.parse(raw) as unknown;
    const capabilities = parseExecutionHostCapabilities(value);
    if (!capabilities) {
      throw new Error("capabilities must contain positive integer versions");
    }
    return capabilities;
  } catch (error) {
    log.warn("Invalid execution host capabilities snapshot", {
      hostId,
      error: String(error),
    });
    return {};
  }
}

function refFromParts(kind: ExecutionHostKind, sourceId: string): ExecutionHostRef {
  const ref = executionHostRefFromParts(kind, sourceId);
  if (!ref) {
    throw new Error(`Unsupported execution host reference: ${kind}:${sourceId}`);
  }
  return ref;
}

function rowToExecutionHost(row: ExecutionHostRow): PersistedExecutionHost {
  return {
    id: row.id,
    userId: row.user_id,
    ref: refFromParts(row.kind, row.source_id),
    targetKey: row.target_key,
    runtime: {
      platform: row.platform_os && row.platform_architecture
        ? normalizeExecutionHostPlatform(
            row.platform_os,
            row.platform_architecture,
          )
        : null,
      capabilities: parseCapabilities(row.capabilities_json, row.id),
    },
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
      id, user_id, kind, source_id, target_key,
      platform_os, platform_architecture, capabilities_json, revision,
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
      id, user_id, kind, source_id, target_key,
      platform_os, platform_architecture, capabilities_json, revision,
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
  options: {
    forceRevision?: boolean;
    runtime?: ExecutionHostRuntimeSnapshot;
  } = {},
): PersistedExecutionHost {
  const db = getDatabase();
  const sourceId = getExecutionHostSourceId(ref);
  const existing = getExecutionHostByRef(userId, ref);
  if (existing) {
    const runtimeChanged = options.runtime !== undefined
      && JSON.stringify(existing.runtime) !== JSON.stringify(options.runtime);
    if (
      existing.targetKey === targetKey
      && existing.revokedAt === null
      && options.forceRevision !== true
      && !runtimeChanged
    ) {
      return existing;
    }
    const updatedAt = new Date().toISOString();
    const targetChanged =
      existing.targetKey !== targetKey
      || existing.revokedAt !== null
      || options.forceRevision === true;
    if (options.runtime) {
      db.query(`
        UPDATE execution_hosts
        SET target_key = ?,
            platform_os = ?,
            platform_architecture = ?,
            capabilities_json = ?,
            revoked_at = NULL,
            revision = revision + ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        targetKey,
        options.runtime.platform?.os ?? null,
        options.runtime.platform?.architecture ?? null,
        JSON.stringify(options.runtime.capabilities),
        targetChanged ? 1 : 0,
        updatedAt,
        existing.id,
        userId,
      );
    } else {
      db.query(`
        UPDATE execution_hosts
        SET target_key = ?, revoked_at = NULL, revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(targetKey, updatedAt, existing.id, userId);
    }
    return getExecutionHostById(userId, existing.id)!;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const runtime = options.runtime ?? { platform: null, capabilities: {} };
  db.query(`
    INSERT INTO execution_hosts (
      id, user_id, kind, source_id, target_key,
      platform_os, platform_architecture, capabilities_json, revision,
      revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `).run(
    id,
    userId,
    ref.kind,
    sourceId,
    targetKey,
    runtime.platform?.os ?? null,
    runtime.platform?.architecture ?? null,
    JSON.stringify(runtime.capabilities),
    now,
    now,
  );
  return getExecutionHostById(userId, id)!;
}

export function updateExecutionHostRuntimeSnapshot(
  userId: string,
  ref: ExecutionHostRef,
  runtime: ExecutionHostRuntimeSnapshot,
): PersistedExecutionHost | null {
  const existing = getExecutionHostByRef(userId, ref);
  if (!existing || JSON.stringify(existing.runtime) === JSON.stringify(runtime)) {
    return existing;
  }
  const now = new Date().toISOString();
  getDatabase().query(`
    UPDATE execution_hosts
    SET platform_os = ?,
        platform_architecture = ?,
        capabilities_json = ?,
        updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    runtime.platform?.os ?? null,
    runtime.platform?.architecture ?? null,
    JSON.stringify(runtime.capabilities),
    now,
    existing.id,
    userId,
  );
  return getExecutionHostById(userId, existing.id);
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

export function deleteExecutionHost(userId: string, hostId: string): boolean {
  const db = getDatabase();
  const hasProvisioningHistory = db.query(
    "SELECT 1 FROM provisioning_jobs WHERE execution_host_id = ? AND user_id = ? LIMIT 1",
  ).get(hostId, userId) !== null;
  if (hasProvisioningHistory) {
    revokeExecutionHost(userId, hostId);
    return false;
  }
  const result = db.query(
    "DELETE FROM execution_hosts WHERE id = ? AND user_id = ?",
  ).run(hostId, userId);
  return result.changes > 0;
}

export function executionHostBindingFromRow(
  row: Record<string, unknown>,
  prefix = "execution_host",
): ExecutionHostBinding | null {
  const kind = row[`${prefix}_kind`];
  const sourceId = row[`${prefix}_source_id`];
  const targetKey = row[`${prefix}_target_key`];
  const revision = row[`${prefix}_revision`];
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

export const PROVISIONING_HOST_JOIN_COLUMNS = `
  provisioning_host.kind AS provisioning_host_kind,
  provisioning_host.source_id AS provisioning_host_source_id,
  provisioning_host.target_key AS provisioning_host_target_key
`;
