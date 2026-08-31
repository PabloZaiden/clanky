/**
 * Local cryptographic identity for server-to-server mesh requests.
 *
 * The private key is kept in the data directory and is never returned by the
 * public identity helpers or replicated to another node.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";
import {
  MESH_INSTANCE_NAME_MAX_LENGTH,
  type MeshNodeIdentity,
} from "@/shared/mesh";
import { getDataDir, getDatabase } from "./database";

const log = createLogger("persistence:mesh-node-identity");
const IDENTITY_FILE_VERSION = 1;
const IDENTITY_FILE_NAME = "node-identity.json";

interface StoredMeshNodeIdentity {
  version: number;
  nodeId: string;
  instanceName: string | null;
  meshEndpoint: string | null;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  encryptionPublicKey?: string;
  encryptionPrivateKey?: string;
  createdAt: string;
  updatedAt: string;
}

interface MeshNodeIdentityRow {
  node_id: string;
  instance_name: string | null;
  mesh_endpoint: string | null;
  public_key: string;
  fingerprint: string;
  encryption_public_key: string | null;
  created_at: string;
  updated_at: string;
}

function identityFilePath(): string {
  return join(getDataDir(), "mesh", IDENTITY_FILE_NAME);
}

function asPem(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

export function validateMeshEncryptionPublicKey(publicKey: string): void {
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("mesh encryption key must be RSA");
    }
  } catch (error) {
    throw new DomainError(
      "mesh_encryption_identity_invalid",
      "The mesh encryption public key is invalid.",
      { cause: error },
    );
  }
}

export function getMeshNodeFingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey);
  const der = key.export({ format: "der", type: "spki" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function normalizeMeshInstanceName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MESH_INSTANCE_NAME_MAX_LENGTH
    || /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new DomainError(
      "mesh_instance_name_invalid",
      `The mesh instance name must be between 1 and ${MESH_INSTANCE_NAME_MAX_LENGTH} visible characters.`,
    );
  }
  return normalized;
}

export function requireMeshInstanceName(identity: MeshNodeIdentity): string {
  if (!identity.instanceName) {
    throw new DomainError(
      "mesh_instance_name_required",
      "Set a mesh instance name before joining a mesh.",
    );
  }
  return identity.instanceName;
}

function parseStoredIdentity(raw: string): StoredMeshNodeIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node identity is not valid JSON.", {
      cause: error,
    });
  }

  if (
    typeof parsed !== "object"
    || parsed === null
  ) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node identity has an invalid shape.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["version"] !== "number"
    || typeof record["nodeId"] !== "string"
    || typeof record["publicKey"] !== "string"
    || typeof record["privateKey"] !== "string"
    || typeof record["fingerprint"] !== "string"
    || typeof record["createdAt"] !== "string"
    || typeof record["updatedAt"] !== "string"
  ) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node identity has an invalid shape.");
  }

  const identity: StoredMeshNodeIdentity = {
    version: record["version"],
    nodeId: record["nodeId"],
    instanceName: null,
    meshEndpoint: null,
    publicKey: record["publicKey"],
    privateKey: record["privateKey"],
    fingerprint: record["fingerprint"],
    createdAt: record["createdAt"],
    updatedAt: record["updatedAt"],
  };

  if (
    record["instanceName"] !== undefined
    && record["instanceName"] !== null
    && typeof record["instanceName"] !== "string"
  ) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh instance name is invalid.");
  }
  if (typeof record["instanceName"] === "string") {
    identity.instanceName = normalizeMeshInstanceName(record["instanceName"]);
  }
  if (
    record["meshEndpoint"] !== undefined
    && record["meshEndpoint"] !== null
    && typeof record["meshEndpoint"] !== "string"
  ) {
    throw new DomainError("mesh_node_identity_invalid", "The stored Mesh endpoint is invalid.");
  }
  if (typeof record["meshEndpoint"] === "string") {
    identity.meshEndpoint = record["meshEndpoint"].trim() || null;
  }

  if (identity.version !== IDENTITY_FILE_VERSION) {
    throw new DomainError("mesh_node_identity_version_unsupported", "The stored mesh node identity version is unsupported.", {
      details: { version: identity.version },
    });
  }

  let derivedFingerprint: string;
  try {
    derivedFingerprint = getMeshNodeFingerprint(identity.publicKey);
    const privateKey = createPrivateKey(identity.privateKey);
    const derivedPublicKey = asPem(createPublicKey(privateKey).export({ format: "pem", type: "spki" }));
    if (getMeshNodeFingerprint(derivedPublicKey) !== derivedFingerprint) {
      throw new Error("private and public keys do not match");
    }
  } catch (error) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node identity keys are invalid.", {
      cause: error,
    });
  }

  if (identity.fingerprint !== derivedFingerprint) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node identity fingerprint does not match its public key.");
  }

  if (
    (record["encryptionPublicKey"] !== undefined && typeof record["encryptionPublicKey"] !== "string")
    || (record["encryptionPrivateKey"] !== undefined && typeof record["encryptionPrivateKey"] !== "string")
    || (record["encryptionPublicKey"] !== undefined) !== (record["encryptionPrivateKey"] !== undefined)
  ) {
    throw new DomainError("mesh_node_identity_invalid", "The stored mesh node encryption keys are invalid.");
  }
  identity.encryptionPublicKey = record["encryptionPublicKey"] as string | undefined;
  identity.encryptionPrivateKey = record["encryptionPrivateKey"] as string | undefined;
  if (identity.encryptionPublicKey && identity.encryptionPrivateKey) {
    validateMeshEncryptionPublicKey(identity.encryptionPublicKey);
    try {
      const privateKey = createPrivateKey(identity.encryptionPrivateKey);
      const derivedPublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
      const expectedPublicKey = createPublicKey(identity.encryptionPublicKey).export({
        format: "der",
        type: "spki",
      });
      if (!Buffer.from(derivedPublicKey).equals(Buffer.from(expectedPublicKey))) {
        throw new Error("mesh encryption private and public keys do not match");
      }
    } catch (error) {
      throw new DomainError(
        "mesh_node_identity_invalid",
        "The stored mesh node encryption keys are invalid.",
        { cause: error },
      );
    }
  }

  return identity;
}

async function readStoredIdentity(): Promise<StoredMeshNodeIdentity | null> {
  const file = Bun.file(identityFilePath());
  if (!(await file.exists())) {
    return null;
  }
  return parseStoredIdentity(await file.text());
}

async function writeStoredIdentity(identity: StoredMeshNodeIdentity): Promise<void> {
  const path = identityFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(identity, null, 2));
  await chmod(path, 0o600);
}

function createStoredIdentity(
  instanceName: string | null = null,
  meshEndpoint: string | null = null,
): StoredMeshNodeIdentity {
  const signingKeys = generateKeyPairSync("ed25519");
  const encryptionKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const { publicKey, privateKey } = signingKeys;
  const publicKeyPem = asPem(publicKey.export({ format: "pem", type: "spki" }));
  const privateKeyPem = asPem(privateKey.export({ format: "pem", type: "pkcs8" }));
  const encryptionPublicKeyPem = asPem(encryptionKeys.publicKey.export({ format: "pem", type: "spki" }));
  const encryptionPrivateKeyPem = asPem(encryptionKeys.privateKey.export({ format: "pem", type: "pkcs8" }));
  const now = new Date().toISOString();
  return {
    version: IDENTITY_FILE_VERSION,
    nodeId: crypto.randomUUID(),
    instanceName,
    meshEndpoint,
    publicKey: publicKeyPem,
    privateKey: privateKeyPem,
    fingerprint: getMeshNodeFingerprint(publicKeyPem),
    encryptionPublicKey: encryptionPublicKeyPem,
    encryptionPrivateKey: encryptionPrivateKeyPem,
    createdAt: now,
    updatedAt: now,
  };
}

function publicIdentity(identity: StoredMeshNodeIdentity): MeshNodeIdentity {
  return {
    nodeId: identity.nodeId,
    instanceName: identity.instanceName,
    meshEndpoint: identity.meshEndpoint,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
    encryptionPublicKey: identity.encryptionPublicKey,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

function upsertIdentityRows(identity: StoredMeshNodeIdentity): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(`
    INSERT INTO mesh_node_identity (
      singleton, node_id, instance_name, mesh_endpoint, public_key, fingerprint, encryption_public_key, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      node_id = excluded.node_id,
      instance_name = excluded.instance_name,
      mesh_endpoint = excluded.mesh_endpoint,
      public_key = excluded.public_key,
      fingerprint = excluded.fingerprint,
      encryption_public_key = excluded.encryption_public_key,
      updated_at = excluded.updated_at
  `, [
    identity.nodeId,
    identity.instanceName,
    identity.meshEndpoint,
    identity.publicKey,
    identity.fingerprint,
    identity.encryptionPublicKey ?? null,
    identity.createdAt,
    now,
  ]);
  db.run(`
    INSERT INTO mesh_nodes (
      node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
      last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'https', 'active', ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      instance_name = excluded.instance_name,
      public_key = excluded.public_key,
      fingerprint = excluded.fingerprint,
      encryption_public_key = excluded.encryption_public_key,
      updated_at = excluded.updated_at
  `, [
    identity.nodeId,
    identity.instanceName,
    identity.publicKey,
    identity.fingerprint,
    identity.encryptionPublicKey ?? null,
    now,
    identity.createdAt,
    now,
  ]);
}

function backfillWorkspaceExecutionNodeOwnership(nodeId: string): void {
  const db = getDatabase();
  if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("workspaces")) {
    return;
  }

  const rows = db.query(`
    SELECT id, server_settings, execution_node_id
    FROM workspaces
  `).all() as Array<{
    id: string;
    server_settings: string | null;
    execution_node_id: string | null;
  }>;
  const assign = db.prepare(`
    UPDATE workspaces
    SET execution_node_id = ?
    WHERE id = ? AND execution_node_id IS NULL
  `);
  const clear = db.prepare(`
    UPDATE workspaces
    SET execution_node_id = NULL
    WHERE id = ?
  `);

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = row.server_settings ? JSON.parse(row.server_settings) : null;
    } catch (error) {
      log.warn("Skipping workspace execution ownership backfill for invalid settings", {
        workspaceId: row.id,
        error: String(error),
      });
      continue;
    }
    const agent = typeof parsed === "object" && parsed !== null
      && typeof (parsed as Record<string, unknown>)["agent"] === "object"
      && (parsed as Record<string, unknown>)["agent"] !== null
      ? (parsed as Record<string, unknown>)["agent"] as Record<string, unknown>
      : null;
    if (agent?.["transport"] === "stdio") {
      if (row.execution_node_id === null) {
        assign.run(nodeId, row.id);
      }
    } else if (agent?.["transport"] === "ssh" && row.execution_node_id !== null) {
      clear.run(row.id);
    }
  }
}

function remapLocalWorkspaceExecutionNode(previousNodeId: string, replacementNodeId: string): void {
  const db = getDatabase();
  if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("workspaces")) {
    return;
  }

  const rows = db.query(`
    SELECT id, server_settings
    FROM workspaces
    WHERE execution_node_id = ?
  `).all(previousNodeId) as Array<{
    id: string;
    server_settings: string | null;
  }>;
  const update = db.prepare(`
    UPDATE workspaces
    SET execution_node_id = ?
    WHERE id = ? AND execution_node_id = ?
  `);

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = row.server_settings ? JSON.parse(row.server_settings) : null;
    } catch (error) {
      log.warn("Skipping workspace execution ownership remap for invalid settings", {
        workspaceId: row.id,
        error: String(error),
      });
      continue;
    }
    const agent = typeof parsed === "object" && parsed !== null
      && typeof (parsed as Record<string, unknown>)["agent"] === "object"
      && (parsed as Record<string, unknown>)["agent"] !== null
      ? (parsed as Record<string, unknown>)["agent"] as Record<string, unknown>
      : null;
    if (agent?.["transport"] === "stdio") {
      update.run(replacementNodeId, row.id, previousNodeId);
    }
  }
}

/**
 * Ensure that this data directory has a durable node identity.
 */
export async function ensureLocalMeshNodeIdentity(): Promise<MeshNodeIdentity> {
  const db = getDatabase();
  const row = db.query(`
    SELECT node_id, instance_name, mesh_endpoint, public_key, fingerprint, encryption_public_key, created_at, updated_at
    FROM mesh_node_identity
    WHERE singleton = 1
  `).get() as MeshNodeIdentityRow | null;
  const stored = await readStoredIdentity();

  if (row && !stored) {
    throw new DomainError(
      "mesh_node_identity_missing",
      "The mesh node private identity is missing from the data directory.",
      { details: { nodeId: row.node_id } },
    );
  }

  let identity = stored ?? createStoredIdentity();
  if (!identity.encryptionPublicKey || !identity.encryptionPrivateKey) {
    const encryptionKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    identity = {
      ...identity,
      encryptionPublicKey: asPem(encryptionKeys.publicKey.export({ format: "pem", type: "spki" })),
      encryptionPrivateKey: asPem(encryptionKeys.privateKey.export({ format: "pem", type: "pkcs8" })),
      updatedAt: new Date().toISOString(),
    };
    await writeStoredIdentity(identity);
  }
  if (row && (
    row.node_id !== identity.nodeId
    || (row.instance_name ?? null) !== identity.instanceName
    || (row.mesh_endpoint ?? null) !== identity.meshEndpoint
    || row.public_key !== identity.publicKey
    || row.fingerprint !== identity.fingerprint
    || (row.encryption_public_key !== null && row.encryption_public_key !== identity.encryptionPublicKey)
  )) {
    throw new DomainError(
      "mesh_node_identity_mismatch",
      "The mesh node identity in the database does not match the local private identity.",
      { details: { nodeId: row.node_id } },
    );
  }

  if (!stored) {
    await writeStoredIdentity(identity);
    log.info("Generated local mesh node identity", {
      nodeId: identity.nodeId,
      fingerprint: identity.fingerprint,
    });
  }
  upsertIdentityRows(identity);
  backfillWorkspaceExecutionNodeOwnership(identity.nodeId);
  return publicIdentity(identity);
}

/**
 * Replace a revoked local node identity before a rejoin pairing flow.
 *
 * A node identity is intentionally never reused after revocation. The
 * previous public key remains in mesh_nodes so peers can reject it forever.
 */
export async function rotateLocalMeshNodeIdentity(): Promise<MeshNodeIdentity> {
  const current = await readStoredIdentity();
  if (!current) {
    throw new DomainError("mesh_node_identity_missing", "The local mesh node identity is unavailable.");
  }
  const db = getDatabase();
  const activeMembership = db.query(`
    SELECT 1
    FROM mesh_link_members
    WHERE node_id = ? AND status = 'active'
    LIMIT 1
  `).get(current.nodeId);
  if (activeMembership) {
    throw new DomainError(
      "mesh_node_rotation_not_allowed",
      "An active mesh node cannot rotate its identity.",
    );
  }

  const replacement = createStoredIdentity(current.instanceName, current.meshEndpoint);
  try {
    await writeStoredIdentity(replacement);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.run(`
        UPDATE mesh_nodes
        SET status = 'revoked', updated_at = ?
        WHERE node_id = ?
      `, [now, current.nodeId]);
      db.run(`
        UPDATE mesh_node_identity
        SET node_id = ?, instance_name = ?, mesh_endpoint = ?, public_key = ?, fingerprint = ?, encryption_public_key = ?,
          created_at = ?, updated_at = ?
        WHERE singleton = 1
      `, [
        replacement.nodeId,
        replacement.instanceName,
        replacement.meshEndpoint,
        replacement.publicKey,
        replacement.fingerprint,
        replacement.encryptionPublicKey ?? null,
        replacement.createdAt,
        replacement.updatedAt,
      ]);
      remapLocalWorkspaceExecutionNode(current.nodeId, replacement.nodeId);
      db.run(`
        INSERT INTO mesh_nodes (
        node_id, instance_name, public_key, fingerprint, encryption_public_key, endpoint, transport, status,
          last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'https', 'rejoining', NULL, ?, ?)
      `, [
        replacement.nodeId,
        replacement.instanceName,
        replacement.publicKey,
        replacement.fingerprint,
        replacement.encryptionPublicKey ?? null,
        replacement.createdAt,
        now,
      ]);
    })();
  } catch (error) {
    await writeStoredIdentity(current);
    throw new DomainError(
      "mesh_node_rotation_failed",
      "The local mesh node identity could not be rotated.",
      { cause: error },
    );
  }
  log.info("Rotated local mesh node identity for mesh rejoin", {
    previousNodeId: current.nodeId,
    nodeId: replacement.nodeId,
  });
  return publicIdentity(replacement);
}

export async function setLocalMeshInstanceName(value: string): Promise<MeshNodeIdentity> {
  const instanceName = normalizeMeshInstanceName(value);
  let identity = await readStoredIdentity();
  if (!identity) {
    await ensureLocalMeshNodeIdentity();
    identity = await readStoredIdentity();
  }
  if (!identity) {
    throw new DomainError("mesh_node_identity_missing", "The local mesh node identity is unavailable.");
  }
  if (identity.instanceName === instanceName) {
    return publicIdentity(identity);
  }
  const updated: StoredMeshNodeIdentity = {
    ...identity,
    instanceName,
    updatedAt: new Date().toISOString(),
  };
  await writeStoredIdentity(updated);
  upsertIdentityRows(updated);
  return publicIdentity(updated);
}

export async function setLocalMeshEndpoint(value: string): Promise<MeshNodeIdentity> {
  let identity = await readStoredIdentity();
  if (!identity) {
    await ensureLocalMeshNodeIdentity();
    identity = await readStoredIdentity();
  }
  if (!identity) {
    throw new DomainError("mesh_node_identity_missing", "The mesh node identity is unavailable.");
  }
  const meshEndpoint = value.trim();
  if (!meshEndpoint) {
    throw new DomainError("mesh_endpoint_invalid", "The Mesh endpoint must not be empty.");
  }
  if (identity.meshEndpoint === meshEndpoint) {
    return publicIdentity(identity);
  }
  const updated: StoredMeshNodeIdentity = {
    ...identity,
    meshEndpoint,
    updatedAt: new Date().toISOString(),
  };
  await writeStoredIdentity(updated);
  upsertIdentityRows(updated);
  return publicIdentity(updated);
}

/**
 * Sign a canonical request payload with the local node private key.
 */
export async function signMeshPayload(payload: string): Promise<string> {
  const identity = await readStoredIdentity();
  if (!identity) {
    await ensureLocalMeshNodeIdentity();
  }
  const resolvedIdentity = identity ?? await readStoredIdentity();
  if (!resolvedIdentity) {
    throw new DomainError("mesh_node_identity_missing", "The local mesh node identity is unavailable.");
  }
  const privateKey = createPrivateKey(resolvedIdentity.privateKey);
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
}

/**
 * Verify a node signature without loading or exposing a local private key.
 */
export function verifyMeshPayloadSignature(
  payload: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      createPublicKey(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch (error) {
    log.debug("Mesh signature verification failed", { error: String(error) });
    return false;
  }
}

/**
 * Expose the local signing key only to the transport boundary.
 */
export async function getLocalMeshSigningKey(): Promise<KeyObject> {
  const identity = await readStoredIdentity();
  if (!identity) {
    await ensureLocalMeshNodeIdentity();
  }
  const resolvedIdentity = identity ?? await readStoredIdentity();
  if (!resolvedIdentity) {
    throw new DomainError("mesh_node_identity_missing", "The local mesh node identity is unavailable.");
  }
  return createPrivateKey(resolvedIdentity.privateKey);
}

export async function getLocalMeshEncryptionPrivateKey(): Promise<KeyObject> {
  let identity = await readStoredIdentity();
  if (!identity?.encryptionPrivateKey) {
    await ensureLocalMeshNodeIdentity();
    identity = await readStoredIdentity();
  }
  if (!identity?.encryptionPrivateKey) {
    throw new DomainError("mesh_node_identity_missing", "The local mesh encryption identity is unavailable.");
  }
  return createPrivateKey(identity.encryptionPrivateKey);
}
