/**
 * Relay-owned Ed25519 identity, independent from the normal Clanky database.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@pablozaiden/webapp/server";

const RELAY_IDENTITY_VERSION = 1;
const RELAY_IDENTITY_FILE_NAME = "relay-identity.json";
const log = createLogger("core:mesh-relay-identity");
let identityMutationTail: Promise<void> = Promise.resolve();

export interface MeshRelayIdentity {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

interface StoredMeshRelayIdentity extends MeshRelayIdentity {
  version: number;
  privateKey: string;
}

export interface MeshRelaySigningIdentity extends MeshRelayIdentity {
  sign(payload: string): string;
}

function asPem(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function relayIdentityPath(dataDir: string): string {
  return join(dataDir, RELAY_IDENTITY_FILE_NAME);
}

async function withIdentityMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = identityMutationTail;
  let release: () => void = () => {};
  identityMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readStoredRelayIdentity(
  dataDir: string,
): Promise<StoredMeshRelayIdentity | undefined> {
  let raw: string;
  try {
    raw = await readFile(relayIdentityPath(dataDir), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw new Error("Failed to read the relay identity.", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("The stored relay identity is not valid JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The stored relay identity has an invalid shape.");
  }
  const record = value as Record<string, unknown>;
  if (
    record["version"] !== RELAY_IDENTITY_VERSION
    || typeof record["publicKey"] !== "string"
    || typeof record["privateKey"] !== "string"
    || typeof record["fingerprint"] !== "string"
    || typeof record["createdAt"] !== "string"
  ) {
    throw new Error("The stored relay identity has an invalid shape.");
  }
  const stored: StoredMeshRelayIdentity = {
    version: RELAY_IDENTITY_VERSION,
    publicKey: record["publicKey"],
    privateKey: record["privateKey"],
    fingerprint: record["fingerprint"],
    createdAt: record["createdAt"],
  };
  validateStoredIdentity(stored);
  await chmod(relayIdentityPath(dataDir), 0o600);
  return stored;
}

function validateEd25519Key(key: KeyObject, label: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`The relay ${label} must be an Ed25519 key.`);
  }
}

function validateStoredIdentity(identity: StoredMeshRelayIdentity): void {
  let publicKey: KeyObject;
  let privateKey: KeyObject;
  try {
    publicKey = createPublicKey(identity.publicKey);
    privateKey = createPrivateKey(identity.privateKey);
    validateEd25519Key(publicKey, "public key");
    validateEd25519Key(privateKey, "private key");
  } catch (error) {
    throw new Error("The stored relay signing key is invalid.", { cause: error });
  }
  const derivedPublicKey = asPem(
    createPublicKey(privateKey).export({ format: "pem", type: "spki" }),
  );
  if (
    derivedPublicKey !== identity.publicKey
    || getMeshRelayFingerprint(identity.publicKey) !== identity.fingerprint
  ) {
    throw new Error("The stored relay signing identity is inconsistent.");
  }
}

function createStoredRelayIdentity(): StoredMeshRelayIdentity {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = asPem(keys.publicKey.export({ format: "pem", type: "spki" }));
  return {
    version: RELAY_IDENTITY_VERSION,
    publicKey,
    privateKey: asPem(keys.privateKey.export({ format: "pem", type: "pkcs8" })),
    fingerprint: getMeshRelayFingerprint(publicKey),
    createdAt: new Date().toISOString(),
  };
}

async function writeStoredRelayIdentity(
  dataDir: string,
  identity: StoredMeshRelayIdentity,
): Promise<boolean> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const target = relayIdentityPath(dataDir);
  const temporary = join(dataDir, `.${RELAY_IDENTITY_FILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
      return false;
    }
    await chmod(target, 0o600);
    return true;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw new Error("Failed to clean up a relay identity temporary file.", {
          cause: error,
        });
      }
    }
  }
}

export function getMeshRelayFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  validateEd25519Key(key, "public key");
  const der = key.export({ format: "der", type: "spki" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function verifyMeshRelaySignature(
  payload: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const key = createPublicKey(publicKey);
    validateEd25519Key(key, "public key");
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch (error) {
    log.debug("Relay signature verification failed", {
      error: String(error),
    });
    return false;
  }
}

export async function ensureMeshRelayIdentity(
  dataDir: string,
): Promise<MeshRelaySigningIdentity> {
  return await withIdentityMutation(async () => {
    let stored = await readStoredRelayIdentity(dataDir);
    if (!stored) {
      const generated = createStoredRelayIdentity();
      stored = await writeStoredRelayIdentity(dataDir, generated)
        ? generated
        : await readStoredRelayIdentity(dataDir);
      if (!stored) {
        throw new Error("The relay identity could not be created.");
      }
    }
    const privateKey = createPrivateKey(stored.privateKey);
    return {
      publicKey: stored.publicKey,
      fingerprint: stored.fingerprint,
      createdAt: stored.createdAt,
      sign(payload: string): string {
        return sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
          "base64url",
        );
      },
    };
  });
}
