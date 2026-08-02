/**
 * File-based key storage for standalone SSH server key pairs.
 */

import { chmod, mkdir, rm, unlink } from "fs/promises";
import { join } from "path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import type { SshKeyAlgorithm, SshServerPublicKey } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDataDir } from "./database";

const log = createLogger("persistence:ssh-server-keys");

export interface PersistedSshServerKeyPair extends SshServerPublicKey {
  privateKey: string;
}

function getSshServerKeysDir(): string {
  return join(getDataDir(), "ssh-server-keys");
}

function getSshServerKeyPath(serverId: string): string {
  return join(getSshServerKeysDir(), `${serverId}.json`);
}

async function ensureSshServerKeysDir(): Promise<void> {
  await mkdir(getSshServerKeysDir(), { recursive: true, mode: 0o700 });
}

function isPersistedKeyPair(value: unknown): value is PersistedSshServerKeyPair {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record["algorithm"] === "RSA-OAEP-256"
    && typeof record["publicKey"] === "string"
    && typeof record["privateKey"] === "string"
    && typeof record["fingerprint"] === "string"
    && typeof record["version"] === "number"
    && typeof record["createdAt"] === "string"
  );
}

export async function saveSshServerKeyPair(
  serverId: string,
  keyPair: PersistedSshServerKeyPair,
): Promise<void> {
  validatePersistedSshServerKeyPair(keyPair);
  await ensureSshServerKeysDir();
  const path = getSshServerKeyPath(serverId);
  await Bun.write(path, JSON.stringify(keyPair));
  await chmod(path, 0o600);
  log.debug("Saved SSH server key pair", {
    serverId,
    algorithm: keyPair.algorithm,
    version: keyPair.version,
  });
}

export async function ensureSshServerKeyPair(
  serverId: string,
): Promise<PersistedSshServerKeyPair> {
  const existing = await loadSshServerKeyPair(serverId);
  if (existing) {
    return existing;
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
  const keyPair = createPersistedSshServerKeyPair({
    publicKey,
    privateKey,
    fingerprint: createPublicKeyFingerprint(publicKey),
    version: 1,
    createdAt: new Date().toISOString(),
  });
  await saveSshServerKeyPair(serverId, keyPair);
  return keyPair;
}

export async function loadSshServerKeyPair(serverId: string): Promise<PersistedSshServerKeyPair | null> {
  const file = Bun.file(getSshServerKeyPath(serverId));
  if (!await file.exists()) {
    return null;
  }

  const raw = await file.text();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPersistedKeyPair(parsed)) {
      log.warn("SSH server key file has invalid shape", { serverId });
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn("Failed to parse SSH server key file", {
      serverId,
      error: String(error),
    });
    return null;
  }
}

export async function deleteSshServerKeyPair(serverId: string): Promise<boolean> {
  try {
    await unlink(getSshServerKeyPath(serverId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function clearSshServerKeyStore(): Promise<void> {
  await rm(getSshServerKeysDir(), { recursive: true, force: true });
}

export function createPersistedSshServerKeyPair(options: {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  version: number;
  createdAt: string;
  algorithm?: SshKeyAlgorithm;
}): PersistedSshServerKeyPair {
  return {
    algorithm: options.algorithm ?? "RSA-OAEP-256",
    publicKey: options.publicKey,
    privateKey: options.privateKey,
    fingerprint: options.fingerprint,
    version: options.version,
    createdAt: options.createdAt,
  };
}

export function validatePersistedSshServerKeyPair(
  keyPair: PersistedSshServerKeyPair,
): void {
  try {
    const publicKey = createPublicKey(keyPair.publicKey);
    const privateKey = createPrivateKey(keyPair.privateKey);
    const derivedPublicKey = createPublicKey(privateKey);
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const derivedPublicDer = derivedPublicKey.export({ format: "der", type: "spki" });
    if (
      keyPair.algorithm !== "RSA-OAEP-256"
      || publicKey.asymmetricKeyType !== "rsa"
      || privateKey.asymmetricKeyType !== "rsa"
      || !Buffer.from(publicDer).equals(Buffer.from(derivedPublicDer))
      || keyPair.fingerprint !== createPublicKeyFingerprint(keyPair.publicKey)
    ) {
      throw new Error("SSH server key pair metadata does not match its key material.");
    }
  } catch (error) {
    throw new Error("SSH server key pair is invalid.", { cause: error });
  }
}

function createPublicKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
}
