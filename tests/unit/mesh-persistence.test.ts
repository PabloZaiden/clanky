import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import {
  applyMeshMembershipUpdate,
  createMeshLink,
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
  setLocalMeshExecutionConfiguration,
  setLocalMeshInstanceName,
} from "../../src/persistence/mesh-node-identity";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { meshManager } from "../../src/core/mesh-manager";
import { buildMeshMembershipUpdateSigningPayload } from "../../src/core/mesh-protocol";
import {
  consumeMeshEnrollmentToken,
  createMeshEnrollmentToken,
} from "../../src/persistence/mesh-enrollment-tokens";
import {
  ensureExecutionHost,
  getExecutionHostById,
  resolveExecutionHostBindingId,
} from "../../src/persistence/execution-hosts";

const createdDataDirs: string[] = [];
const originalPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];

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
  if (originalPublicBaseUrl === undefined) {
    delete process.env["CLANKY_PUBLIC_BASE_URL"];
  } else {
    process.env["CLANKY_PUBLIC_BASE_URL"] = originalPublicBaseUrl;
  }
  while (createdDataDirs.length > 0) {
    const path = createdDataDirs.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("mesh transport control-plane persistence", () => {
  test("consumes enrollment tokens exactly once", async () => {
    await setupDatabase();
    const created = createMeshEnrollmentToken("owner-1", "Worker", 300, {
      linkId: "link-1",
      nodeId: "controller-1",
      fingerprint: "sha256:controller",
    });

    expect(consumeMeshEnrollmentToken(created.token, {
      nodeId: "wrong-controller",
      fingerprint: "sha256:controller",
    })).toBeNull();
    expect(consumeMeshEnrollmentToken(created.token, {
      nodeId: "controller-1",
      fingerprint: "sha256:controller",
    })).toEqual({
      userId: "owner-1",
      linkId: "link-1",
      controllerNodeId: "controller-1",
      controllerFingerprint: "sha256:controller",
    });
    expect(consumeMeshEnrollmentToken(created.token, {
      nodeId: "controller-1",
      fingerprint: "sha256:controller",
    })).toBeNull();
  });

  test("persists node-owned execution policy with explicit capabilities", async () => {
    await setupDatabase();
    const initial = await ensureLocalMeshNodeIdentity();
    expect(initial.execution?.acceptRemoteExecution).toBe(true);
    expect(initial.execution?.capabilities.commandExecution).toBe(1);
    expect(initial.execution?.capabilities.interactiveTerminal).toBe(1);

    const updated = await setLocalMeshExecutionConfiguration({
      acceptRemoteExecution: false,
      repositoriesBasePath: "/srv/workspaces",
    });

    expect(updated.execution?.acceptRemoteExecution).toBe(false);
    expect(updated.execution?.repositoriesBasePath).toBe("/srv/workspaces");
    expect(updated.execution?.revision).toBe((initial.execution?.revision ?? 0) + 1);

    const reloaded = await ensureLocalMeshNodeIdentity();
    expect(reloaded.execution).toEqual(updated.execution);
    expect((await getMeshNode(updated.nodeId))?.execution).toEqual(updated.execution);
  });

  test("resolving a persisted binding does not overwrite current host metadata", async () => {
    await setupDatabase();
    const host = ensureExecutionHost(
      "owner-1",
      { kind: "mesh", nodeId: "node-1" },
      "current-target",
    );

    expect(resolveExecutionHostBindingId("owner-1", {
      host: host.ref,
      targetKey: "stale-target",
      revision: host.revision - 1,
    })).toBe(host.id);
    expect(getExecutionHostById("owner-1", host.id)).toMatchObject({
      targetKey: "current-target",
      revision: host.revision,
    });
  });

  test("materializes and persists the public base URL for an unset Mesh endpoint", async () => {
    await setupDatabase();
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://browser.example.test:3001";

    const materialized = (await meshManager.getStatus("user-1")).node;
    expect(materialized.meshEndpoint).toBe("http://browser.example.test:3001");
    expect(getDatabase().query(`
      SELECT mesh_endpoint
      FROM mesh_node_identity
      WHERE singleton = 1
    `).get()).toEqual({ mesh_endpoint: "http://browser.example.test:3001" });

    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://changed.example.test:3002";
    expect((await meshManager.getStatus("user-1")).node.meshEndpoint)
      .toBe("http://browser.example.test:3001");
  });

  test("exposes the materialized endpoint through Mesh status and local node metadata", async () => {
    await setupDatabase();
    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://browser.example.test:3001/";

    const status = await meshManager.getStatus("user-1");
    expect(status.node.meshEndpoint).toBe("http://browser.example.test:3001");
    expect((await getMeshNode(status.node.nodeId))?.endpoint)
      .toBe("http://browser.example.test:3001");
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

  test("preserves a direct pairing route while updating the advertised peer endpoint", async () => {
    await setupDatabase();
    const { linkId } = await createLocalLink();
    const remote = createSigningIdentity();
    await mergeMeshLinkMember({
      linkId,
      nodeId: "remote-node",
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://127.0.0.1:3002",
      endpointSource: "paired",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remote.publicKey,
      fingerprint: remote.fingerprint,
    });

    await applyMeshMembershipUpdate(linkId, [{
      nodeId: "remote-node",
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://localhost:3002",
      transport: "http",
      status: "active",
      membershipGeneration: 2,
      publicKey: remote.publicKey,
      fingerprint: remote.fingerprint,
    }]);

    expect((await listMeshLinkMembers(linkId))
      .find((member) => member.nodeId === "remote-node")?.endpoint)
      .toBe("http://127.0.0.1:3002");
    expect((await listMeshMembershipEntries(linkId))
      .find((member) => member.nodeId === "remote-node")?.endpoint)
      .toBe("http://localhost:3002");
  });

});
