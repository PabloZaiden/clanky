import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { SshServerConfig, SshServerSession } from "../../src/types";
import { createPersistedSshServerKeyPair } from "../../src/persistence/ssh-server-keys";

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

function createTestSshServerSession(overrides?: Partial<SshServerSession["config"]>): SshServerSession {
  const now = new Date().toISOString();
  return {
    config: {
      id: overrides?.id ?? "ssh-server-session-1",
      sshServerId: overrides?.sshServerId ?? "ssh-server-1",
      name: overrides?.name ?? "Deploy shell",
      connectionMode: "dtach",
      useTmux: overrides?.useTmux ?? true,
      remoteSessionName: overrides?.remoteSessionName ?? "clanky-ssh-session-1",
      createdAt: overrides?.createdAt ?? now,
      updatedAt: overrides?.updatedAt ?? now,
    },
    state: {
      status: "ready",
    },
  };
}

describe("SSH server persistence", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

  test("persists standalone SSH servers and hydrates public key metadata from key storage", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const {
      saveSshServerConfig,
      getSshServer,
      listSshServers,
    } = await import("../../src/persistence/ssh-servers");
    const { saveSshServerKeyPair } = await import("../../src/persistence/ssh-server-keys");

    await ensureDataDirectories();

    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);
    await saveSshServerKeyPair(server.id, createPersistedSshServerKeyPair({
      publicKey: "public-key-pem",
      privateKey: "private-key-pem",
      fingerprint: "fingerprint-1",
      version: 1,
      createdAt: server.createdAt,
    }));

    const loaded = await getSshServer(server.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.config.address).toBe("ssh.example.com");
    expect(loaded?.publicKey.fingerprint).toBe("fingerprint-1");

    const listed = await listSshServers();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.config.username).toBe("deploy");
  });

  test("deletes key material when deleting a standalone SSH server", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const { saveSshServerConfig, deleteSshServer } = await import("../../src/persistence/ssh-servers");
    const {
      saveSshServerKeyPair,
      loadSshServerKeyPair,
    } = await import("../../src/persistence/ssh-server-keys");

    await ensureDataDirectories();

    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);
    await saveSshServerKeyPair(server.id, createPersistedSshServerKeyPair({
      publicKey: "public-key-pem",
      privateKey: "private-key-pem",
      fingerprint: "fingerprint-1",
      version: 1,
      createdAt: server.createdAt,
    }));

    expect(await loadSshServerKeyPair(server.id)).not.toBeNull();
    expect(await deleteSshServer(server.id)).toBe(true);
    expect(await loadSshServerKeyPair(server.id)).toBeNull();
  });

  test("persists standalone SSH server sessions per server", async () => {
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    const {
      saveSshServerConfig,
      saveSshServerSession,
      getSshServerSession,
      listSshServerSessionsByServerId,
      countSshServerSessionsByServerId,
      deleteSshServerSession,
    } = await import("../../src/persistence/ssh-servers");
    const { saveSshServerKeyPair } = await import("../../src/persistence/ssh-server-keys");

    await ensureDataDirectories();

    const server = createTestSshServerConfig();
    await saveSshServerConfig(server);
    await saveSshServerKeyPair(server.id, createPersistedSshServerKeyPair({
      publicKey: "public-key-pem",
      privateKey: "private-key-pem",
      fingerprint: "fingerprint-1",
      version: 1,
      createdAt: server.createdAt,
    }));

    const session = createTestSshServerSession();
    await saveSshServerSession(session);

    expect(await countSshServerSessionsByServerId(server.id)).toBe(1);
    expect((await getSshServerSession(session.config.id))?.config.sshServerId).toBe(server.id);
    expect(await listSshServerSessionsByServerId(server.id)).toHaveLength(1);
    expect(await deleteSshServerSession(session.config.id)).toBe(true);
  });
});
