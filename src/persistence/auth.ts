/**
 * Persistence helpers for bearer-token and device authorization state.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getDatabase } from "./database";
import { createLogger } from "../core/logger";

const log = createLogger("persistence:auth");

const AUTH_INSTANCE_ID_KEY = "authInstanceId";
const AUTH_CANONICAL_ISSUER_KEY = "authCanonicalIssuer";
const AUTH_SIGNING_KEY_KEY = "authSigningKey";

export type DeviceAuthRequestStatus = "pending" | "approved" | "denied" | "consumed";
export type RefreshSessionRevocationReason = "manual" | "rotated" | "reuse_detected" | "expired";

export interface StoredSigningKey {
  alg: "EdDSA" | "ES256";
  kid: string;
  publicJwk: Record<string, string>;
  privateJwk: Record<string, string>;
  createdAt: string;
}

export interface DeviceAuthRequestRecord {
  id: string;
  clientId: string;
  deviceCodeHash: string;
  userCode: string;
  scope: string;
  status: DeviceAuthRequestStatus;
  expiresAt: string;
  approvedAt?: string;
  deniedAt?: string;
  lastPolledAt?: string;
  pollCount: number;
  subject?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RefreshSessionRecord {
  id: string;
  familyId: string;
  subject: string;
  clientId: string;
  scope: string;
  refreshTokenHash: string;
  refreshExpiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revocationReason?: RefreshSessionRevocationReason;
  replacedBySessionId?: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateRefreshSessionInput = Omit<
  RefreshSessionRecord,
  "createdAt" | "updatedAt" | "lastUsedAt" | "revokedAt" | "revocationReason" | "replacedBySessionId"
>;

function getPreference(key: string): string | null {
  const db = getDatabase();
  const row = db.query("SELECT value FROM preferences WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setPreference(key: string, value: string): void {
  const db = getDatabase();
  db.run(
    `
      INSERT INTO preferences (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    [key, value],
  );
}

function deletePreference(key: string): void {
  const db = getDatabase();
  db.run("DELETE FROM preferences WHERE key = ?", [key]);
}

function safeJsonParse<T>(json: string | null, fallback: T, fieldName: string): T {
  if (!json) {
    return fallback;
  }

  try {
    return JSON.parse(json) as T;
  } catch (error) {
    log.warn(`Failed to parse auth JSON field "${fieldName}": ${String(error)}`);
    return fallback;
  }
}

function mapDeviceAuthRequest(row: Record<string, unknown>): DeviceAuthRequestRecord {
  return {
    id: row["id"] as string,
    clientId: row["client_id"] as string,
    deviceCodeHash: row["device_code_hash"] as string,
    userCode: row["user_code"] as string,
    scope: row["scope"] as string,
    status: row["status"] as DeviceAuthRequestStatus,
    expiresAt: row["expires_at"] as string,
    approvedAt: (row["approved_at"] as string | null) ?? undefined,
    deniedAt: (row["denied_at"] as string | null) ?? undefined,
    lastPolledAt: (row["last_polled_at"] as string | null) ?? undefined,
    pollCount: Number(row["poll_count"]),
    subject: (row["subject"] as string | null) ?? undefined,
    sessionId: (row["session_id"] as string | null) ?? undefined,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function mapRefreshSession(row: Record<string, unknown>): RefreshSessionRecord {
  return {
    id: row["id"] as string,
    familyId: row["family_id"] as string,
    subject: row["subject"] as string,
    clientId: row["client_id"] as string,
    scope: row["scope"] as string,
    refreshTokenHash: row["refresh_token_hash"] as string,
    refreshExpiresAt: row["refresh_expires_at"] as string,
    lastUsedAt: (row["last_used_at"] as string | null) ?? undefined,
    revokedAt: (row["revoked_at"] as string | null) ?? undefined,
    revocationReason: (row["revocation_reason"] as RefreshSessionRevocationReason | null) ?? undefined,
    replacedBySessionId: (row["replaced_by_session_id"] as string | null) ?? undefined,
    parentSessionId: (row["parent_session_id"] as string | null) ?? undefined,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export async function getAuthInstanceId(): Promise<string | undefined> {
  return getPreference(AUTH_INSTANCE_ID_KEY) ?? undefined;
}

export async function setAuthInstanceId(instanceId: string): Promise<void> {
  setPreference(AUTH_INSTANCE_ID_KEY, instanceId);
}

export async function getCanonicalIssuer(): Promise<string | undefined> {
  return getPreference(AUTH_CANONICAL_ISSUER_KEY) ?? undefined;
}

export async function setCanonicalIssuer(issuer?: string): Promise<void> {
  if (!issuer) {
    deletePreference(AUTH_CANONICAL_ISSUER_KEY);
    return;
  }
  setPreference(AUTH_CANONICAL_ISSUER_KEY, issuer);
}

export async function getStoredSigningKey(): Promise<StoredSigningKey | undefined> {
  const raw = getPreference(AUTH_SIGNING_KEY_KEY);
  return safeJsonParse<StoredSigningKey | undefined>(raw, undefined, "signing_key");
}

export async function saveStoredSigningKey(key: StoredSigningKey): Promise<void> {
  setPreference(AUTH_SIGNING_KEY_KEY, JSON.stringify(key));
}

export async function createDeviceAuthRequest(input: Omit<DeviceAuthRequestRecord, "createdAt" | "updatedAt">): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `
      INSERT INTO auth_device_requests (
        id,
        client_id,
        device_code_hash,
        user_code,
        scope,
        status,
        expires_at,
        approved_at,
        denied_at,
        last_polled_at,
        poll_count,
        subject,
        session_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.id,
      input.clientId,
      input.deviceCodeHash,
      input.userCode,
      input.scope,
      input.status,
      input.expiresAt,
      input.approvedAt ?? null,
      input.deniedAt ?? null,
      input.lastPolledAt ?? null,
      input.pollCount,
      input.subject ?? null,
      input.sessionId ?? null,
      now,
      now,
    ],
  );
}

export async function getDeviceAuthRequestByUserCode(userCode: string): Promise<DeviceAuthRequestRecord | undefined> {
  const db = getDatabase();
  const row = db.query(
    `
      SELECT
        id,
        client_id,
        device_code_hash,
        user_code,
        scope,
        status,
        expires_at,
        approved_at,
        denied_at,
        last_polled_at,
        poll_count,
        subject,
        session_id,
        created_at,
        updated_at
      FROM auth_device_requests
      WHERE user_code = ?
    `,
  ).get(userCode) as Record<string, unknown> | null;

  return row ? mapDeviceAuthRequest(row) : undefined;
}

export async function getDeviceAuthRequestByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceAuthRequestRecord | undefined> {
  const db = getDatabase();
  const row = db.query(
    `
      SELECT
        id,
        client_id,
        device_code_hash,
        user_code,
        scope,
        status,
        expires_at,
        approved_at,
        denied_at,
        last_polled_at,
        poll_count,
        subject,
        session_id,
        created_at,
        updated_at
      FROM auth_device_requests
      WHERE device_code_hash = ?
    `,
  ).get(deviceCodeHash) as Record<string, unknown> | null;

  return row ? mapDeviceAuthRequest(row) : undefined;
}

export async function updateDeviceAuthRequest(
  id: string,
  update: {
    status?: DeviceAuthRequestStatus;
    approvedAt?: string | null;
    deniedAt?: string | null;
    lastPolledAt?: string | null;
    pollCount?: number;
    subject?: string | null;
    sessionId?: string | null;
  },
): Promise<void> {
  const db = getDatabase();
  db.run(
    `
      UPDATE auth_device_requests
      SET
        status = COALESCE(?, status),
        approved_at = COALESCE(?, approved_at),
        denied_at = COALESCE(?, denied_at),
        last_polled_at = COALESCE(?, last_polled_at),
        poll_count = COALESCE(?, poll_count),
        subject = COALESCE(?, subject),
        session_id = COALESCE(?, session_id),
        updated_at = ?
      WHERE id = ?
    `,
    [
      update.status ?? null,
      update.approvedAt ?? null,
      update.deniedAt ?? null,
      update.lastPolledAt ?? null,
      update.pollCount ?? null,
      update.subject ?? null,
      update.sessionId ?? null,
      new Date().toISOString(),
      id,
    ],
  );
}

export async function createRefreshSession(
  input: CreateRefreshSessionInput,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  insertRefreshSessionRow(db, input, now);
}

function insertRefreshSessionRow(db: Database, input: CreateRefreshSessionInput, now: string): void {
  db.run(
    `
      INSERT INTO auth_refresh_sessions (
        id,
        family_id,
        subject,
        client_id,
        scope,
        refresh_token_hash,
        refresh_expires_at,
        last_used_at,
        revoked_at,
        revocation_reason,
        replaced_by_session_id,
        parent_session_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.id,
      input.familyId,
      input.subject,
      input.clientId,
      input.scope,
      input.refreshTokenHash,
      input.refreshExpiresAt,
      null,
      null,
      null,
      null,
      input.parentSessionId ?? null,
      now,
      now,
      ],
  );
}

export async function getRefreshSessionById(id: string): Promise<RefreshSessionRecord | undefined> {
  const db = getDatabase();
  const row = db.query(
    `
      SELECT
        id,
        family_id,
        subject,
        client_id,
        scope,
        refresh_token_hash,
        refresh_expires_at,
        last_used_at,
        revoked_at,
        revocation_reason,
        replaced_by_session_id,
        parent_session_id,
        created_at,
        updated_at
      FROM auth_refresh_sessions
      WHERE id = ?
    `,
  ).get(id) as Record<string, unknown> | null;

  return row ? mapRefreshSession(row) : undefined;
}

export async function getRefreshSessionByTokenHash(refreshTokenHash: string): Promise<RefreshSessionRecord | undefined> {
  const db = getDatabase();
  const row = db.query(
    `
      SELECT
        id,
        family_id,
        subject,
        client_id,
        scope,
        refresh_token_hash,
        refresh_expires_at,
        last_used_at,
        revoked_at,
        revocation_reason,
        replaced_by_session_id,
        parent_session_id,
        created_at,
        updated_at
      FROM auth_refresh_sessions
      WHERE refresh_token_hash = ?
    `,
  ).get(refreshTokenHash) as Record<string, unknown> | null;

  return row ? mapRefreshSession(row) : undefined;
}

export async function listLatestRefreshSessions(): Promise<RefreshSessionRecord[]> {
  const db = getDatabase();
  const rows = db.query(
    `
      WITH ranked_sessions AS (
        SELECT
          id,
          family_id,
          subject,
          client_id,
          scope,
          refresh_token_hash,
          refresh_expires_at,
          last_used_at,
          revoked_at,
          revocation_reason,
          replaced_by_session_id,
          parent_session_id,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY family_id
            ORDER BY created_at DESC, updated_at DESC, id DESC
          ) AS family_rank
        FROM auth_refresh_sessions
      )
      SELECT
        id,
        family_id,
        subject,
        client_id,
        scope,
        refresh_token_hash,
        refresh_expires_at,
        last_used_at,
        revoked_at,
        revocation_reason,
        replaced_by_session_id,
        parent_session_id,
        created_at,
        updated_at
      FROM ranked_sessions
      WHERE family_rank = 1
      ORDER BY created_at DESC, updated_at DESC, id DESC
    `,
  ).all() as Record<string, unknown>[];

  return rows.map(mapRefreshSession);
}

export async function consumeApprovedDeviceAuthRequest(
  id: string,
  session: CreateRefreshSessionInput,
): Promise<boolean> {
  const db = getDatabase();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const result = db.run(
      `
        UPDATE auth_device_requests
        SET
          status = 'consumed',
          subject = ?,
          session_id = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'approved'
      `,
      [session.subject, session.id, now, id],
    );
    if (result.changes === 0) {
      return false;
    }

    insertRefreshSessionRow(db, session, now);
    return true;
  })();
}

export async function markRefreshSessionRotated(
  id: string,
  replacedBySessionId: string,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `
      UPDATE auth_refresh_sessions
      SET
        last_used_at = ?,
        revoked_at = ?,
        revocation_reason = 'rotated',
        replaced_by_session_id = ?,
        updated_at = ?
      WHERE id = ?
    `,
    [now, now, replacedBySessionId, now, id],
  );
}

export async function rotateRefreshSessionAtomically(
  id: string,
  nextSession: CreateRefreshSessionInput,
): Promise<boolean> {
  const db = getDatabase();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const result = db.run(
      `
        UPDATE auth_refresh_sessions
        SET
          last_used_at = ?,
          revoked_at = ?,
          revocation_reason = 'rotated',
          replaced_by_session_id = ?,
          updated_at = ?
        WHERE id = ?
          AND revoked_at IS NULL
      `,
      [now, now, nextSession.id, now, id],
    );
    if (result.changes === 0) {
      return false;
    }

    insertRefreshSessionRow(db, nextSession, now);
    return true;
  })();
}

export async function touchRefreshSession(id: string, throttleMs = 0): Promise<boolean> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const threshold = new Date(Date.now() - throttleMs).toISOString();
  const result = db.run(
    `
      UPDATE auth_refresh_sessions
      SET
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
        AND (
          last_used_at IS NULL
          OR last_used_at <= ?
        )
    `,
    [now, now, id, threshold],
  );
  return result.changes > 0;
}

export async function revokeRefreshSession(
  id: string,
  reason: RefreshSessionRevocationReason,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `
      UPDATE auth_refresh_sessions
      SET
        revoked_at = COALESCE(revoked_at, ?),
        revocation_reason = COALESCE(revocation_reason, ?),
        updated_at = ?
      WHERE id = ?
    `,
    [now, reason, now, id],
  );
}

export async function revokeRefreshFamily(
  familyId: string,
  reason: RefreshSessionRevocationReason,
): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `
      UPDATE auth_refresh_sessions
      SET
        revoked_at = COALESCE(revoked_at, ?),
        revocation_reason = COALESCE(revocation_reason, ?),
        updated_at = ?
      WHERE family_id = ?
    `,
    [now, reason, now, familyId],
  );
}
