/**
 * File-based key storage for standalone SSH server key pairs.
 */

import { mkdir, rm, unlink } from "fs/promises";
import { join } from "path";
import type { SshKeyAlgorithm, SshServerPublicKey } from "@/shared";
import { createLogger } from "../core/logger";
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
  await mkdir(getSshServerKeysDir(), { recursive: true });
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
  await ensureSshServerKeysDir();
  await Bun.write(getSshServerKeyPath(serverId), JSON.stringify(keyPair));
  log.debug("Saved SSH server key pair", {
    serverId,
    algorithm: keyPair.algorithm,
    version: keyPair.version,
  });
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
