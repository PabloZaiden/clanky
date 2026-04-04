/**
 * Persistence helpers for passkey authentication state.
 */

import type {
  AuthenticatorTransportFuture,
  Base64URLString,
  CredentialDeviceType,
} from "@simplewebauthn/server";
import { getDatabase } from "./database";
import { createLogger } from "../core/logger";

const log = createLogger("persistence:passkey-auth");

const PASSKEY_AUTH_SECRET_KEY = "passkeyAuthSecret";
const PASSKEY_AUTH_VERSION_KEY = "passkeyAuthVersion";

export interface StoredPasskey {
  id: string;
  name: string;
  credentialId: Base64URLString;
  publicKey: Uint8Array;
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports: AuthenticatorTransportFuture[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface SavePasskeyInput {
  id: string;
  name: string;
  credentialId: Base64URLString;
  publicKey: Uint8Array;
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports?: AuthenticatorTransportFuture[];
}

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
    log.warn(`Failed to parse passkey auth JSON field "${fieldName}": ${String(error)}`);
    return fallback;
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error("Expected public key bytes from database");
}

function mapStoredPasskey(row: Record<string, unknown>): StoredPasskey {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    credentialId: row["credential_id"] as Base64URLString,
    publicKey: toUint8Array(row["public_key"]),
    counter: Number(row["counter"]),
    deviceType: row["device_type"] as CredentialDeviceType,
    backedUp: Number(row["backed_up"]) === 1,
    transports: safeJsonParse<AuthenticatorTransportFuture[]>(
      row["transports"] as string | null,
      [],
      "transports",
    ),
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
    lastUsedAt: (row["last_used_at"] as string | null) ?? undefined,
  };
}

export async function listPasskeys(): Promise<StoredPasskey[]> {
  const db = getDatabase();
  const rows = db.query(
    `
      SELECT
        id,
        name,
        credential_id,
        public_key,
        counter,
        device_type,
        backed_up,
        transports,
        created_at,
        updated_at,
        last_used_at
      FROM passkey_credentials
      ORDER BY created_at ASC
    `,
  ).all() as Record<string, unknown>[];

  return rows.map(mapStoredPasskey);
}

export async function getPasskeyByCredentialId(
  credentialId: Base64URLString,
): Promise<StoredPasskey | undefined> {
  const db = getDatabase();
  const row = db.query(
    `
      SELECT
        id,
        name,
        credential_id,
        public_key,
        counter,
        device_type,
        backed_up,
        transports,
        created_at,
        updated_at,
        last_used_at
      FROM passkey_credentials
      WHERE credential_id = ?
    `,
  ).get(credentialId) as Record<string, unknown> | null;

  return row ? mapStoredPasskey(row) : undefined;
}

export async function hasRegisteredPasskeys(): Promise<boolean> {
  const db = getDatabase();
  const row = db.query("SELECT COUNT(*) AS count FROM passkey_credentials").get() as { count: number };
  return row.count > 0;
}

export async function savePasskey(input: SavePasskeyInput): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();
  const transportsJson = JSON.stringify(input.transports ?? []);
  db.run(
    `
      INSERT INTO passkey_credentials (
        id,
        name,
        credential_id,
        public_key,
        counter,
        device_type,
        backed_up,
        transports,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        credential_id = excluded.credential_id,
        public_key = excluded.public_key,
        counter = excluded.counter,
        device_type = excluded.device_type,
        backed_up = excluded.backed_up,
        transports = excluded.transports,
        updated_at = excluded.updated_at
    `,
    [
      input.id,
      input.name,
      input.credentialId,
      input.publicKey,
      input.counter,
      input.deviceType,
      input.backedUp ? 1 : 0,
      transportsJson,
      now,
      now,
    ],
  );
}

export async function updatePasskeyUsage(
  credentialId: Base64URLString,
  counter: number,
  transports?: AuthenticatorTransportFuture[],
): Promise<void> {
  const db = getDatabase();
  db.run(
    `
      UPDATE passkey_credentials
      SET
        counter = ?,
        transports = ?,
        last_used_at = ?,
        updated_at = ?
      WHERE credential_id = ?
    `,
    [
      counter,
      JSON.stringify(transports ?? []),
      new Date().toISOString(),
      new Date().toISOString(),
      credentialId,
    ],
  );
}

export async function deleteAllPasskeys(): Promise<void> {
  const db = getDatabase();
  db.run("DELETE FROM passkey_credentials");
}

export async function getPasskeyAuthVersion(): Promise<number> {
  const raw = getPreference(PASSKEY_AUTH_VERSION_KEY);
  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    log.warn("Invalid stored passkey auth version; falling back to zero", { raw });
    return 0;
  }

  return parsed;
}

export async function bumpPasskeyAuthVersion(): Promise<number> {
  const nextVersion = (await getPasskeyAuthVersion()) + 1;
  setPreference(PASSKEY_AUTH_VERSION_KEY, String(nextVersion));
  return nextVersion;
}

export async function getPasskeyAuthSecret(): Promise<string | undefined> {
  return getPreference(PASSKEY_AUTH_SECRET_KEY) ?? undefined;
}

export async function getOrCreatePasskeyAuthSecret(): Promise<string> {
  const existing = await getPasskeyAuthSecret();
  if (existing) {
    return existing;
  }

  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  setPreference(PASSKEY_AUTH_SECRET_KEY, secret);
  return secret;
}

export async function resetPasskeyAuthConfiguration(): Promise<void> {
  deletePreference(PASSKEY_AUTH_SECRET_KEY);
  deletePreference(PASSKEY_AUTH_VERSION_KEY);
}
