/**
 * Key lifecycle manager for standalone SSH servers.
 */

import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import type { SshServerEncryptedCredential, SshServerPublicKey } from "@/shared";
import { getSshServerConfig } from "../persistence/ssh-servers";
import {
  createPersistedSshServerKeyPair,
  deleteSshServerKeyPair,
  loadSshServerKeyPair,
  saveSshServerKeyPair,
  type PersistedSshServerKeyPair,
} from "../persistence/ssh-server-keys";
import { createLogger } from "./logger";

const log = createLogger("core:ssh-server-key-manager");
const SSH_SERVER_KEY_MODULUS_LENGTH = 4096;

function buildPublicKeyFingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(publicKey)
    .digest("hex");
}

function toPublicKey(keyPair: PersistedSshServerKeyPair): SshServerPublicKey {
  return {
    algorithm: keyPair.algorithm,
    publicKey: keyPair.publicKey,
    fingerprint: keyPair.fingerprint,
    version: keyPair.version,
    createdAt: keyPair.createdAt,
  };
}

function generatePersistedKeyPair(version: number): PersistedSshServerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: SSH_SERVER_KEY_MODULUS_LENGTH,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
  return createPersistedSshServerKeyPair({
    publicKey,
    privateKey,
    fingerprint: buildPublicKeyFingerprint(publicKey),
    version,
    createdAt: new Date().toISOString(),
  });
}

export class SshServerKeyManager {
  async getPublicKey(serverId: string): Promise<SshServerPublicKey | null> {
    const server = await getSshServerConfig(serverId);
    if (!server) {
      return null;
    }

    const keyPair = await loadSshServerKeyPair(serverId);
    return keyPair ? toPublicKey(keyPair) : null;
  }

  async ensurePublicKey(serverId: string): Promise<SshServerPublicKey> {
    const existing = await this.getExistingOrThrow(serverId);
    if (existing) {
      return toPublicKey(existing);
    }

    const generated = generatePersistedKeyPair(1);
    await saveSshServerKeyPair(serverId, generated);
    log.info("Generated standalone SSH server key pair", {
      serverId,
      version: generated.version,
      fingerprint: generated.fingerprint,
    });
    return toPublicKey(generated);
  }

  async rotateKeyPair(serverId: string): Promise<SshServerPublicKey> {
    const existing = await this.getExistingOrThrow(serverId);
    const nextVersion = (existing?.version ?? 0) + 1;
    const rotated = generatePersistedKeyPair(nextVersion);
    await saveSshServerKeyPair(serverId, rotated);
    log.info("Rotated standalone SSH server key pair", {
      serverId,
      version: rotated.version,
      fingerprint: rotated.fingerprint,
    });
    return toPublicKey(rotated);
  }

  async deleteKeyPair(serverId: string): Promise<boolean> {
    return await deleteSshServerKeyPair(serverId);
  }

  async decryptCredential(serverId: string, credential: SshServerEncryptedCredential): Promise<string> {
    const keyPair = await this.requireKeyPair(serverId);
    if (credential.algorithm !== keyPair.algorithm) {
      throw new Error("Encrypted SSH credential algorithm does not match the registered server key");
    }
    if (credential.fingerprint !== keyPair.fingerprint || credential.version !== keyPair.version) {
      throw new Error("Encrypted SSH credential does not match the current registered server key");
    }

    const plaintext = privateDecrypt({
      key: keyPair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from(credential.ciphertext, "base64"));
    return plaintext.toString("utf8");
  }

  private async getExistingOrThrow(serverId: string): Promise<PersistedSshServerKeyPair | null> {
    const server = await getSshServerConfig(serverId);
    if (!server) {
      throw new Error(`SSH server not found: ${serverId}`);
    }
    return await loadSshServerKeyPair(serverId);
  }

  private async requireKeyPair(serverId: string): Promise<PersistedSshServerKeyPair> {
    const existing = await this.getExistingOrThrow(serverId);
    if (existing) {
      return existing;
    }
    await this.ensurePublicKey(serverId);
    const generated = await loadSshServerKeyPair(serverId);
    if (!generated) {
      throw new Error(`Failed to generate SSH server key pair for server ${serverId}`);
    }
    return generated;
  }
}

export const sshServerKeyManager = new SshServerKeyManager();
