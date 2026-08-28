import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  applyMeshMembershipUpdate,
  createMeshLink,
  createMeshPairingRequest,
  getMeshNode,
  listMeshLinkMembers,
  listMeshMembershipEntries,
  mergeMeshLinkMember,
  removeRevokedMeshLinkMember,
  revokeMeshLinkMember,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
  setLocalMeshInstanceName,
} from "../../src/persistence/mesh-node-identity";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { meshManager } from "../../src/core/mesh-manager";
import { buildMeshMembershipUpdateSigningPayload } from "../../src/core/mesh-protocol";
import { DomainError } from "../../src/core/domain-error";

const createdDataDirs: string[] = [];

function createSigningIdentity(): {
  privateKey: KeyObject;
  publicKey: string;
  fingerprint: string;
} {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKey: keyPair.privateKey,
    publicKey,
    fingerprint: getMeshNodeFingerprint(publicKey),
  };
}

async function setupDatabase(): Promise<void> {
  const dataDir = join(
    process.cwd(),
    ".clanky-test-tmp",
    `mesh-control-${crypto.randomUUID()}`,
  );
  await mkdir(dataDir, { recursive: true });
  createdDataDirs.push(dataDir);
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES ('user-1', 'user-1', 'user', 1, ?, ?, NULL, NULL)
  `, [now, now]);
}

async function createLocalLink(): Promise<{
  linkId: string;
  identity: Awaited<ReturnType<typeof ensureLocalMeshNodeIdentity>>;
}> {
  await setLocalMeshInstanceName("Local instance");
  const identity = await ensureLocalMeshNodeIdentity();
  const link = await createMeshLink({
    localUserId: "user-1",
    localNodeId: identity.nodeId,
    localNodeEndpoint: "http://127.0.0.1:3001",
    localNodeTransport: "http",
  });
  return { linkId: link.linkId, identity };
}

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  while (createdDataDirs.length > 0) {
    const path = createdDataDirs.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("mesh transport control-plane persistence", () => {
  test("persists node identity and authority-free links", async () => {
    await setupDatabase();
    const { linkId, identity } = await createLocalLink();

    const stored = await getMeshNode(identity.nodeId);
    const linkRow = getDatabase().query(`
      SELECT link_id, status
      FROM mesh_links
      WHERE link_id = ?
    `).get(linkId);

    expect(stored?.instanceName).toBe("Local instance");
    expect(linkRow).toEqual({ link_id: linkId, status: "active" });
    expect(getDatabase().query("PRAGMA table_info(mesh_links)").all())
      .not.toContainEqual(expect.objectContaining({ name: "active_node_id" }));
  });

  test("revokes and removes members without authority takeover", async () => {
    await setupDatabase();
    const { linkId } = await createLocalLink();
    const remote = createSigningIdentity();
    await mergeMeshLinkMember({
      linkId,
      nodeId: "remote-node",
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://127.0.0.1:3002",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remote.publicKey,
      fingerprint: remote.fingerprint,
    });

    const revoked = await revokeMeshLinkMember({
      linkId,
      localUserId: "user-1",
      nodeId: "remote-node",
    });
    expect(revoked.status).toBe("revoked");

    await removeRevokedMeshLinkMember({
      linkId,
      localUserId: "user-1",
      nodeId: "remote-node",
    });
    expect((await listMeshLinkMembers(linkId)).map((member) => member.nodeId))
      .not.toContain("remote-node");
  });

  test("rejects duplicate active instance names within a mesh", async () => {
    await setupDatabase();
    const { linkId } = await createLocalLink();
    const first = createSigningIdentity();
    const second = createSigningIdentity();

    await mergeMeshLinkMember({
      linkId,
      nodeId: "remote-1",
      instanceName: "Build host",
      localUserId: "remote-user-1",
      endpoint: "http://127.0.0.1:3002",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: first.publicKey,
      fingerprint: first.fingerprint,
    });

    await expect(mergeMeshLinkMember({
      linkId,
      nodeId: "remote-2",
      instanceName: "build HOST",
      localUserId: "remote-user-2",
      endpoint: "http://127.0.0.1:3003",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: second.publicKey,
      fingerprint: second.fingerprint,
    })).rejects.toMatchObject({
      code: "mesh_instance_name_conflict",
    });
  });

  test("applies signed membership-only control updates", async () => {
    await setupDatabase();
    const { linkId } = await createLocalLink();
    const remote = createSigningIdentity();
    await mergeMeshLinkMember({
      linkId,
      nodeId: "remote-node",
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://127.0.0.1:3002",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remote.publicKey,
      fingerprint: remote.fingerprint,
    });
    const members = await listMeshMembershipEntries(linkId);
    const unsigned = {
      protocolVersion: 1 as const,
      linkId,
      senderNodeId: "remote-node",
      senderPublicKey: remote.publicKey,
      senderFingerprint: remote.fingerprint,
      nonce: crypto.randomUUID(),
      members,
    };
    const signature = sign(
      null,
      Buffer.from(buildMeshMembershipUpdateSigningPayload(unsigned), "utf8"),
      remote.privateKey,
    ).toString("base64url");

    await expect(meshManager.receiveMembershipUpdate({ ...unsigned, signature }))
      .resolves.toEqual({ status: "accepted", memberCount: 2 });
  });

  test("rejects membership updates containing duplicate names before applying them", async () => {
    await setupDatabase();
    const { linkId } = await createLocalLink();
    const first = createSigningIdentity();
    const second = createSigningIdentity();
    const members = [
      {
        nodeId: "remote-1",
        instanceName: "Duplicate",
        localUserId: "remote-user-1",
        endpoint: "http://127.0.0.1:3002",
        transport: "http" as const,
        status: "active" as const,
        membershipGeneration: 1,
        publicKey: first.publicKey,
        fingerprint: first.fingerprint,
      },
      {
        nodeId: "remote-2",
        instanceName: "duplicate",
        localUserId: "remote-user-2",
        endpoint: "http://127.0.0.1:3003",
        transport: "http" as const,
        status: "active" as const,
        membershipGeneration: 1,
        publicKey: second.publicKey,
        fingerprint: second.fingerprint,
      },
    ];

    await expect(applyMeshMembershipUpdate(linkId, members))
      .rejects.toBeInstanceOf(DomainError);
    expect(await listMeshLinkMembers(linkId)).toHaveLength(1);
  });

  test("stores incoming pairing requests without app-data state", async () => {
    await setupDatabase();
    const remote = createSigningIdentity();
    const request = await createMeshPairingRequest({
      direction: "incoming",
      requestedNodeId: "remote-node",
      requestedInstanceName: "Remote instance",
      requestedLocalUserId: "remote-user",
      endpoint: "http://127.0.0.1:3002",
      transport: "http",
      publicKey: remote.publicKey,
      fingerprint: remote.fingerprint,
      nonce: crypto.randomUUID(),
      signature: "signed-request",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(request.status).toBe("pending");
    expect(getDatabase().query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_sync_checkpoints'",
    ).get()).toBeNull();
  });
});
