/**
 * Persistence for workspace-owned SSH execution targets.
 *
 * Endpoint metadata is stored in SQLite. Passwords are encrypted with an
 * installation-local key that is kept outside the database and restricted to
 * the Clanky data directory.
 */

import { chmod } from "fs/promises";
import { join } from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { WorkspaceSshTarget } from "@/shared/workspace";
import type { ExecutionHostBinding } from "@/shared/execution-host";
import { getDatabase, getDataDir } from "./database";
import { requirePersistenceUserId } from "./ownership";
import {
  ensureExecutionHost,
  getExecutionHostByRef,
  revokeExecutionHost,
  type PersistedExecutionHost,
} from "./execution-hosts";
import { buildSshTargetKey } from "./workspace-target-key";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTED_PASSWORD_VERSION = "v1";

interface WorkspaceExecutionTargetRow {
  workspace_id: string;
  user_id: string;
  host: string | null;
  port: number | null;
  username: string | null;
  password_ciphertext: string | null;
  target_key: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceSshTargetPersistenceState {
  targetRow: WorkspaceExecutionTargetRow | null;
  host: PersistedExecutionHost | null;
}

export interface WorkspaceSshTargetInput {
  host: string;
  port: number;
  username: string;
  password?: string | null;
}

export interface PersistedWorkspaceSshTarget extends WorkspaceSshTarget {
  password?: string;
}

let cachedKeyPath: string | null = null;
let cachedEncryptionKey: Buffer | null = null;

function getEncryptionKeyPath(): string {
  return join(getDataDir(), "workspace-execution-target.key");
}

async function getEncryptionKey(): Promise<Buffer> {
  const keyPath = getEncryptionKeyPath();
  if (cachedKeyPath === keyPath && cachedEncryptionKey) {
    if (await Bun.file(keyPath).exists()) {
      return cachedEncryptionKey;
    }
    cachedKeyPath = null;
    cachedEncryptionKey = null;
  }

  const file = Bun.file(keyPath);
  if (await file.exists()) {
    const raw = (await file.text()).trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== ENCRYPTION_KEY_BYTES) {
      throw new Error("Workspace execution target encryption key is invalid");
    }
    cachedKeyPath = keyPath;
    cachedEncryptionKey = key;
    return key;
  }

  const key = randomBytes(ENCRYPTION_KEY_BYTES);
  await Bun.write(keyPath, key.toString("base64"));
  await chmod(keyPath, 0o600);
  cachedKeyPath = keyPath;
  cachedEncryptionKey = key;
  return key;
}

async function encryptPassword(password: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_PASSWORD_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

async function decryptPassword(value: string): Promise<string> {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (
    version !== ENCRYPTED_PASSWORD_VERSION
    || !ivValue
    || !tagValue
    || !ciphertextValue
  ) {
    throw new Error("Workspace execution target password has an invalid format");
  }

  try {
    const key = await getEncryptionKey();
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(ivValue, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt workspace execution target password", {
      cause: error,
    });
  }
}

function workspaceTargetRef(workspaceId: string) {
  return {
    kind: "ssh",
    scope: "workspace",
    workspaceId,
  } as const;
}

function normalizeInput(input: WorkspaceSshTargetInput): {
  host: string;
  port: number;
  username: string;
  password?: string | null;
  passwordProvided: boolean;
} {
  const host = input.host.trim();
  const username = input.username.trim();
  const port = Math.floor(input.port);
  if (!host || !username || port < 1 || port > 65535) {
    throw new Error("Workspace SSH target requires a valid host, port, and username");
  }
  const passwordProvided = Object.prototype.hasOwnProperty.call(input, "password");
  const password = passwordProvided
    ? input.password === null
      ? null
      : input.password?.trim() || null
    : undefined;
  return { host, port, username, password, passwordProvided };
}

interface PreparedWorkspaceSshTarget {
  normalized: ReturnType<typeof normalizeInput>;
  existing: WorkspaceExecutionTargetRow | null;
  existingHost: PersistedExecutionHost | null;
  targetKey: string;
  forceRevision: boolean;
}

function prepareWorkspaceSshTargetRecord(
  workspaceId: string,
  input: WorkspaceSshTargetInput,
  userId: string,
): PreparedWorkspaceSshTarget {
  const normalized = normalizeInput(input);
  const existing = getTargetRow(workspaceId, userId);
  const existingHost = getExecutionHostByRef(userId, workspaceTargetRef(workspaceId));
  const endpointChanged = !existing
    || existing.host !== normalized.host
    || existing.port !== normalized.port
    || existing.username !== normalized.username;
  const targetKey = buildSshTargetKey(
    normalized.host,
    normalized.port,
    normalized.username,
  );
  const targetChanged = endpointChanged || normalized.passwordProvided;
  return {
    normalized,
    existing,
    existingHost,
    targetKey,
    forceRevision: targetChanged && Boolean(existingHost) && !endpointChanged,
  };
}

/**
 * Registers the canonical execution-host identity for a workspace target
 * without writing the workspace-owned target row.
 *
 * Workspace creation uses this before inserting the workspace record because
 * the target row itself has a foreign key back to that record.
 */
export function prepareWorkspaceSshTarget(
  workspaceId: string,
  input: WorkspaceSshTargetInput,
  userId: string = requirePersistenceUserId(),
): {
  binding: ExecutionHostBinding;
  target: WorkspaceSshTarget;
} {
  const prepared = prepareWorkspaceSshTargetRecord(workspaceId, input, userId);
  const host = ensureExecutionHost(
    userId,
    workspaceTargetRef(workspaceId),
    prepared.targetKey,
    { forceRevision: prepared.forceRevision },
  );
  return {
    binding: {
      host: workspaceTargetRef(workspaceId),
      targetKey: host.targetKey,
      revision: host.revision,
    },
    target: {
      kind: "ssh",
      host: prepared.normalized.host,
      port: prepared.normalized.port,
      username: prepared.normalized.username,
      credentialConfigured: prepared.normalized.passwordProvided
        ? Boolean(prepared.normalized.password)
        : Boolean(prepared.existing?.password_ciphertext),
      targetKey: host.targetKey,
      revision: host.revision,
    },
  };
}

function rowToSummary(
  row: WorkspaceExecutionTargetRow,
): WorkspaceSshTarget | null {
  if (
    typeof row.host !== "string"
    || typeof row.port !== "number"
    || typeof row.username !== "string"
    || !row.host.trim()
    || !row.username.trim()
  ) {
    return null;
  }
  return {
    kind: "ssh",
    host: row.host,
    port: row.port,
    username: row.username,
    credentialConfigured: Boolean(row.password_ciphertext),
    targetKey: row.target_key,
    revision: Math.max(1, Math.floor(row.revision)),
  };
}

function getTargetRow(
  workspaceId: string,
  userId: string,
): WorkspaceExecutionTargetRow | null {
  return getDatabase().query(`
    SELECT
      workspace_id, user_id, host, port, username, password_ciphertext,
      target_key, revision, created_at, updated_at
    FROM workspace_execution_targets
    WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId) as WorkspaceExecutionTargetRow | null;
}

export function captureWorkspaceSshTargetState(
  workspaceId: string,
  userId: string = requirePersistenceUserId(),
): WorkspaceSshTargetPersistenceState {
  return {
    targetRow: getTargetRow(workspaceId, userId),
    host: getExecutionHostByRef(userId, workspaceTargetRef(workspaceId)),
  };
}

/**
 * Restores the target row and canonical host identity captured before a
 * workspace update. This keeps a failed target mutation from leaving the
 * workspace binding and target metadata out of sync.
 */
export function restoreWorkspaceSshTargetState(
  workspaceId: string,
  state: WorkspaceSshTargetPersistenceState,
  userId: string = requirePersistenceUserId(),
): void {
  const db = getDatabase();
  const currentHost = getExecutionHostByRef(userId, workspaceTargetRef(workspaceId));
  db.transaction(() => {
    if (state.targetRow) {
      const row = state.targetRow;
      db.query(`
        INSERT INTO workspace_execution_targets (
          workspace_id, user_id, host, port, username, password_ciphertext,
          target_key, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          user_id = excluded.user_id,
          host = excluded.host,
          port = excluded.port,
          username = excluded.username,
          password_ciphertext = excluded.password_ciphertext,
          target_key = excluded.target_key,
          revision = excluded.revision,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        row.workspace_id,
        row.user_id,
        row.host,
        row.port,
        row.username,
        row.password_ciphertext,
        row.target_key,
        row.revision,
        row.created_at,
        row.updated_at,
      );
    } else {
      db.query(
        "DELETE FROM workspace_execution_targets WHERE workspace_id = ? AND user_id = ?",
      ).run(workspaceId, userId);
    }

    if (state.host) {
      db.query(`
        UPDATE execution_hosts
        SET target_key = ?, revision = ?, revoked_at = ?, created_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        state.host.targetKey,
        state.host.revision,
        state.host.revokedAt,
        state.host.createdAt,
        state.host.updatedAt,
        state.host.id,
        userId,
      );
    } else if (currentHost) {
      const now = new Date().toISOString();
      db.query(`
        UPDATE execution_hosts
        SET revoked_at = COALESCE(revoked_at, ?), revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(now, now, currentHost.id, userId);
    }
  })();
}

export async function getWorkspaceSshTargetSummary(
  workspaceId: string,
  userId: string = requirePersistenceUserId(),
): Promise<WorkspaceSshTarget | null> {
  const row = getTargetRow(workspaceId, userId);
  return row ? rowToSummary(row) : null;
}

export async function getWorkspaceSshTarget(
  workspaceId: string,
  userId: string = requirePersistenceUserId(),
): Promise<PersistedWorkspaceSshTarget | null> {
  const row = getTargetRow(workspaceId, userId);
  if (!row) {
    return null;
  }
  const summary = rowToSummary(row);
  if (!summary) {
    return null;
  }
  return {
    ...summary,
    ...(row.password_ciphertext
      ? { password: await decryptPassword(row.password_ciphertext) }
      : {}),
  };
}

export async function ensureWorkspaceSshTarget(
  workspaceId: string,
  input: WorkspaceSshTargetInput,
  userId: string = requirePersistenceUserId(),
): Promise<{
  binding: ExecutionHostBinding;
  target: PersistedWorkspaceSshTarget;
}> {
  const prepared = prepareWorkspaceSshTargetRecord(workspaceId, input, userId);
  const { normalized, existing } = prepared;
  const passwordCiphertext = normalized.passwordProvided
    ? normalized.password
      ? await encryptPassword(normalized.password)
      : null
    : existing?.password_ciphertext ?? null;
  const host = getDatabase().transaction(() => {
    const ensuredHost = ensureExecutionHost(
      userId,
      workspaceTargetRef(workspaceId),
      prepared.targetKey,
      { forceRevision: prepared.forceRevision },
    );
    const now = new Date().toISOString();
    getDatabase().query(`
      INSERT INTO workspace_execution_targets (
        workspace_id, user_id, host, port, username, password_ciphertext,
        target_key, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        user_id = excluded.user_id,
        host = excluded.host,
        port = excluded.port,
        username = excluded.username,
        password_ciphertext = excluded.password_ciphertext,
        target_key = excluded.target_key,
        revision = excluded.revision,
        updated_at = excluded.updated_at
      WHERE workspace_execution_targets.user_id = excluded.user_id
    `).run(
      workspaceId,
      userId,
      normalized.host,
      normalized.port,
      normalized.username,
      passwordCiphertext,
      ensuredHost.targetKey,
      ensuredHost.revision,
      existing?.created_at ?? now,
      now,
    );
    return ensuredHost;
  })();

  return {
    binding: {
      host: workspaceTargetRef(workspaceId),
      targetKey: host.targetKey,
      revision: host.revision,
    },
    target: {
      kind: "ssh",
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      credentialConfigured: Boolean(passwordCiphertext),
      targetKey: host.targetKey,
      revision: host.revision,
      ...(passwordCiphertext
        ? { password: normalized.password ?? undefined }
        : {}),
    },
  };
}

export async function removeWorkspaceSshTarget(
  workspaceId: string,
  userId: string = requirePersistenceUserId(),
): Promise<void> {
  getDatabase().query(
    "DELETE FROM workspace_execution_targets WHERE workspace_id = ? AND user_id = ?",
  ).run(workspaceId, userId);
  const host = getExecutionHostByRef(userId, workspaceTargetRef(workspaceId));
  if (host) {
    revokeExecutionHost(userId, host.id);
  }
}

export function resetWorkspaceExecutionTargetCredentialCache(): void {
  cachedKeyPath = null;
  cachedEncryptionKey = null;
}
