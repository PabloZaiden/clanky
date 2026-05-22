import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { SshServerConfig } from "../../src/types";

let testDataDir: string;

function createTestSshServerConfig(overrides?: Partial<SshServerConfig>): SshServerConfig {
  const now = new Date().toISOString();
    return {
      id: overrides?.id ?? "ssh-server-1",
      name: overrides?.name ?? "Shared host",
      address: overrides?.address ?? "ssh.example.com",
      username: overrides?.username ?? "deploy",
      repositoriesBasePath: overrides?.repositoriesBasePath ?? null,
      createdAt: overrides?.createdAt ?? now,
      updatedAt: overrides?.updatedAt ?? now,
    };
}

describe("SshServerKeyManager", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-keys-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

  test("ensurePublicKey generates and reuses a key pair for a registered server", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const { saveSshServerConfig } = await import("../../src/persistence/ssh-servers");
    const { sshServerKeyManager } = await import("../../src/core/ssh-server-key-manager");

    await ensureDataDirectories();
    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);

    const first = await sshServerKeyManager.ensurePublicKey(server.id);
    const second = await sshServerKeyManager.ensurePublicKey(server.id);

    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKey).toBe(first.publicKey);
  });

  test("rotateKeyPair increments the key version and changes the fingerprint", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const { saveSshServerConfig } = await import("../../src/persistence/ssh-servers");
    const { sshServerKeyManager } = await import("../../src/core/ssh-server-key-manager");

    await ensureDataDirectories();
    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);

    const first = await sshServerKeyManager.ensurePublicKey(server.id);
    const rotated = await sshServerKeyManager.rotateKeyPair(server.id);

    expect(rotated.version).toBe(2);
    expect(rotated.fingerprint).not.toBe(first.fingerprint);
  });

  test("decryptCredential decrypts RSA-OAEP encrypted browser credentials", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const { saveSshServerConfig } = await import("../../src/persistence/ssh-servers");
    const { sshServerKeyManager } = await import("../../src/core/ssh-server-key-manager");

    await ensureDataDirectories();
    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);

    const publicKey = await sshServerKeyManager.ensurePublicKey(server.id);
    const ciphertext = publicEncrypt({
      key: publicKey.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from("super-secret-password", "utf8")).toString("base64");

    const plaintext = await sshServerKeyManager.decryptCredential(server.id, {
      algorithm: publicKey.algorithm,
      fingerprint: publicKey.fingerprint,
      version: publicKey.version,
      ciphertext,
    });

    expect(plaintext).toBe("super-secret-password");
  });

  test("decryptCredential rejects stale encrypted credentials after rotation", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const { saveSshServerConfig } = await import("../../src/persistence/ssh-servers");
    const { sshServerKeyManager } = await import("../../src/core/ssh-server-key-manager");

    await ensureDataDirectories();
    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);

    const original = await sshServerKeyManager.ensurePublicKey(server.id);
    const ciphertext = publicEncrypt({
      key: original.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, Buffer.from("super-secret-password", "utf8")).toString("base64");
    await sshServerKeyManager.rotateKeyPair(server.id);

    await expect(sshServerKeyManager.decryptCredential(server.id, {
      algorithm: original.algorithm,
      fingerprint: original.fingerprint,
      version: original.version,
      ciphertext,
    })).rejects.toThrow("does not match the current registered server key");
  });
});
