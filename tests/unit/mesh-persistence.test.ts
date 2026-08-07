import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  approveMeshPairingRequest,
  applyMeshLinkTakeover,
  claimMeshLinkForLocalUser,
  createMeshLink,
  createMeshPairingRequest,
  getActiveMeshLinkTakeover,
  getMeshLinkForUser,
  getMeshLinkById,
  getMeshPairingRequest,
  getMeshLinkMembershipSnapshot,
  listMeshLinkMembers,
  listMeshNodes,
  listPendingMeshPairingRequests,
  mergeMeshLinkMember,
  revokeMeshLinkMember,
  saveMeshNode,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
  setLocalMeshInstanceName,
  signMeshPayload,
  verifyMeshPayloadSignature,
} from "../../src/persistence/mesh-node-identity";
import { meshManager } from "../../src/core/mesh-manager";
import { assertMeshApiMutationAllowed } from "../../src/core/mesh-api-guard";
import {
  buildMeshPairingRequestSigningPayload,
  buildMeshSyncPushSigningPayload,
  buildMeshTakeoverSigningPayload,
} from "../../src/core/mesh-protocol";
import { receiveMeshSyncPush } from "../../src/core/mesh-sync-manager";
import { applyMeshCheckpoint } from "../../src/core/mesh-sync-service";
import {
  decryptMeshPayload,
  encryptMeshPayload,
} from "../../src/core/mesh-payload-crypto";
import {
  listOpenMeshSyncConflicts,
  recordMeshSyncConflict,
} from "../../src/persistence/mesh-sync";
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceMeshPayload,
  saveWorkspaceFromMesh,
} from "../../src/persistence/workspaces";
import {
  getSshServerMeshPayload,
  getSshServer,
  saveSshServerConfig,
  saveSshServerFromMesh,
} from "../../src/persistence/ssh-servers";
import { runWithCurrentUser } from "../../src/core/user-context";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

const createdDataDirs: string[] = [];
const originalPublicBaseUrl = process.env["CLANKY_PUBLIC_BASE_URL"];

async function setupDatabase(): Promise<void> {
  const setupDataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-"));
  createdDataDirs.push(setupDataDir);
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = setupDataDir;
  await initializeDatabase();
}

async function createNodeDatabase(userId: string): Promise<{
  dataDir: string;
  identity: Awaited<ReturnType<typeof ensureLocalMeshNodeIdentity>>;
}> {
  const nodeDataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-node-"));
  createdDataDirs.push(nodeDataDir);
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = nodeDataDir;
  await initializeDatabase();
  await seedUser(userId);
  await ensureLocalMeshNodeIdentity();
  await setLocalMeshInstanceName(`${userId} instance`);
  const identity = await ensureLocalMeshNodeIdentity();
  return { dataDir: nodeDataDir, identity };
}

async function useNodeDatabase(nodeDataDir: string, userId: string): Promise<void> {
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = nodeDataDir;
  await initializeDatabase();
  await seedUserIfMissing(userId);
}

async function seedUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES (?, ?, 'user', 1, ?, ?, NULL, NULL)
  `, [id, id, now, now]);
}

async function seedUserIfMissing(id: string): Promise<void> {
  const existing = getDatabase().query("SELECT id FROM webapp_users WHERE id = ?").get(id);
  if (!existing) {
    await seedUser(id);
  }
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

describe("mesh persistence", () => {
  test("creates and reuses a local node identity", async () => {
    await setupDatabase();

    const first = await ensureLocalMeshNodeIdentity();
    const second = await ensureLocalMeshNodeIdentity();
    const payload = JSON.stringify({ nodeId: first.nodeId, nonce: "nonce-1" });
    const signature = await signMeshPayload(payload);

    expect(second).toEqual(first);
    expect(first.fingerprint.startsWith("sha256:")).toBe(true);
    expect(verifyMeshPayloadSignature(payload, signature, first.publicKey)).toBe(true);
    expect(verifyMeshPayloadSignature(`${payload}-changed`, signature, first.publicKey)).toBe(false);
  });

  test("persists the instance name with the local node identity", async () => {
    await setupDatabase();

    const first = await ensureLocalMeshNodeIdentity();
    expect(first.instanceName).toBeNull();

    const named = await setLocalMeshInstanceName("Primary instance");
    expect(named.instanceName).toBe("Primary instance");
    expect((await ensureLocalMeshNodeIdentity()).instanceName).toBe("Primary instance");
    expect((await listMeshNodes()).find((node) => node.nodeId === named.nodeId)?.instanceName)
      .toBe("Primary instance");
  });

  test("does not contact a peer when the advertised endpoint is not configured", async () => {
    await setupDatabase();
    await seedUser("local-user");
    await ensureLocalMeshNodeIdentity();
    await setLocalMeshInstanceName("Local instance");
    delete process.env["CLANKY_PUBLIC_BASE_URL"];

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(async () => {
      fetchCalls += 1;
      throw new Error("peer should not be contacted");
    }, { preconnect: originalFetch.preconnect });

    try {
      await expect(meshManager.startPairing(
        "local-user",
        "local-user",
        { targetEndpoint: "http://127.0.0.1:4100" },
      )).rejects.toMatchObject({ code: "mesh_public_base_url_not_configured" });
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rotates a revoked identity before starting a rejoin pairing", async () => {
    await setupDatabase();
    await seedUser("local-user");
    await ensureLocalMeshNodeIdentity();
    await setLocalMeshInstanceName("Local instance");
    const previousIdentity = await ensureLocalMeshNodeIdentity();
    const remoteKeyPair = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const remoteNodeId = crypto.randomUUID();
    const remoteFingerprint = getMeshNodeFingerprint(remotePublicKey);

    await saveMeshNode({
      nodeId: remoteNodeId,
      instanceName: "Remote instance",
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      endpoint: "http://remote.example.test",
      transport: "http",
      status: "active",
    });
    const link = await createMeshLink({
      localUserId: "local-user",
      localNodeId: previousIdentity.nodeId,
      localNodeEndpoint: "http://local.example.test",
      localNodeTransport: "http",
    });
    await mergeMeshLinkMember({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://remote.example.test",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
    });
    await applyMeshLinkTakeover({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      generation: 2,
      claimedAt: new Date().toISOString(),
      claimOrigin: "test",
      signature: "remote-claim",
    });
    await revokeMeshLinkMember({
      linkId: link.linkId,
      localUserId: "local-user",
      nodeId: previousIdentity.nodeId,
    });

    process.env["CLANKY_PUBLIC_BASE_URL"] = "http://local.example.test/";
    const originalFetch = globalThis.fetch;
    let sentEndpoint = "";
    let sentAdvertisedEndpoint = "";
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      sentEndpoint = String(input);
      const body = JSON.parse(String(init?.body)) as { endpoint: string };
      sentAdvertisedEndpoint = body.endpoint;
      return Response.json({ status: "pending" });
    }, { preconnect: originalFetch.preconnect });

    try {
      const status = await meshManager.rejoin(
        "local-user",
        "local-user",
        { targetEndpoint: "http://remote.example.test" },
      );
      expect(status.node.nodeId).not.toBe(previousIdentity.nodeId);
      expect(status.pendingPairingRequests).toHaveLength(1);
      expect(sentEndpoint).toBe("http://remote.example.test/api/mesh/internal/pairing-requests");
      expect(sentAdvertisedEndpoint).toBe("http://local.example.test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("encrypts mesh payloads for the recipient node", async () => {
    const nodeA = await createNodeDatabase("user-a");
    const nodeB = await createNodeDatabase("user-b");
    const secret = {
      password: "do-not-send-in-cleartext",
      nested: ["value", 42],
    };

    const encrypted = encryptMeshPayload(secret, nodeB.identity.encryptionPublicKey!);
    expect(encrypted).not.toEqual(secret);
    expect(encrypted.ciphertext).not.toContain(secret.password);

    await useNodeDatabase(nodeB.dataDir, "user-b");
    await expect(decryptMeshPayload(encrypted)).resolves.toEqual(secret);

    await useNodeDatabase(nodeA.dataDir, "user-a");
    await expect(decryptMeshPayload(encrypted)).rejects.toMatchObject({
      code: "mesh_payload_decryption_failed",
    });
  });

  describe("mesh API guard", () => {
    test("allows only the parameterized pairing completion route while bypassing authority checks", async () => {
      await setupDatabase();
      await seedUser("user");
      const user: CurrentUser = {
        id: "user",
        username: "user",
        role: "user",
        isOwner: false,
        isAdmin: false,
      };

      await expect(assertMeshApiMutationAllowed(
        user,
        new Request("https://mesh.example.test/api/mesh/pairing-requests/request-1/complete", {
          method: "POST",
        }),
      )).resolves.toBeUndefined();

      const remoteNodeKeyPair = generateKeyPairSync("ed25519");
      const remoteNodePublicKey = remoteNodeKeyPair.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      const remoteNodeId = crypto.randomUUID();
      await saveMeshNode({
        nodeId: remoteNodeId,
        publicKey: remoteNodePublicKey,
        fingerprint: getMeshNodeFingerprint(remoteNodePublicKey),
        endpoint: "https://active.example.test",
        transport: "https",
        status: "active",
      });
      await createMeshLink({
        localUserId: "user",
        localNodeId: remoteNodeId,
        localNodeEndpoint: "https://active.example.test",
        localNodeTransport: "https",
      });
      await expect(assertMeshApiMutationAllowed(
        user,
        new Request("https://mesh.example.test/api/mesh/pairing-requests/request-1/approve", {
          method: "POST",
        }),
      )).rejects.toMatchObject({ code: "mesh_link_revoked" });
    });
  });

  test("replicates standalone SSH server metadata without transferring private keys", async () => {
    const nodeA = await createNodeDatabase("user-a");
    const nodeB = await createNodeDatabase("user-b");
    const server = {
      id: crypto.randomUUID(),
      name: "Remote SSH",
      address: "ssh.example.test",
      username: "developer",
      repositoriesBasePath: "/repos",
      isPrivate: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await useNodeDatabase(nodeA.dataDir, "user-a");
    await runWithCurrentUser(
      { id: "user-a", username: "user-a", role: "user", isOwner: false, isAdmin: false },
      () => saveSshServerConfig(server),
    );
    const payload = await getSshServerMeshPayload(server);
    expect(payload.publicKey.publicKey.length).toBeGreaterThan(100);
    expect(JSON.stringify(payload)).not.toContain("privateKey");

    await useNodeDatabase(nodeB.dataDir, "user-b");
    await runWithCurrentUser(
      { id: "user-b", username: "user-b", role: "user", isOwner: false, isAdmin: false },
      () => saveSshServerFromMesh(payload),
    );
    const replicated = await runWithCurrentUser(
      { id: "user-b", username: "user-b", role: "user", isOwner: false, isAdmin: false },
      () => getSshServer(server.id),
    );
    expect(replicated?.config).toEqual(server);
    expect(replicated?.publicKey.algorithm).toBe(payload.publicKey.algorithm);
    expect(replicated?.publicKey).not.toEqual(payload.publicKey);
  });

  test("replicates SSH workspace metadata without transferring identity files", async () => {
    const nodeA = await createNodeDatabase("user-a");
    const nodeB = await createNodeDatabase("user-b");
    const identityFilePath = join(nodeA.dataDir, "source-id_ed25519");
    const identityFileContent = "-----BEGIN OPENSSH PRIVATE KEY-----\nmesh-test\n-----END OPENSSH PRIVATE KEY-----\n";
    await Bun.write(identityFilePath, identityFileContent);
    const workspace = {
      id: crypto.randomUUID(),
      name: "Portable SSH workspace",
      directory: "/remote/workspace",
      serverSettings: {
        agent: {
          provider: "opencode" as const,
          transport: "ssh" as const,
          hostname: "remote.example",
          port: 22,
          identityFile: identityFilePath,
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const userA: CurrentUser = {
      id: "user-a",
      username: "user-a",
      role: "user",
      isOwner: false,
      isAdmin: false,
    };
    const userB: CurrentUser = {
      ...userA,
      id: "user-b",
      username: "user-b",
    };

    await useNodeDatabase(nodeA.dataDir, "user-a");
    const payload = await runWithCurrentUser(userA, () => getWorkspaceMeshPayload(workspace));
    expect(payload.workspace.serverSettings.agent.transport).toBe("ssh");
    if (payload.workspace.serverSettings.agent.transport === "ssh") {
      expect(payload.workspace.serverSettings.agent.identityFile).toBeUndefined();
    }
    expect(payload.identityFile).toEqual({ configured: true });
    expect(JSON.stringify(payload)).not.toContain(identityFileContent);

    await useNodeDatabase(nodeB.dataDir, "user-b");
    const localIdentityFilePath = join(nodeB.dataDir, "local-id_ed25519");
    const localIdentityFileContent = "local-key-material";
    await Bun.write(localIdentityFilePath, localIdentityFileContent);
    await runWithCurrentUser(userB, () => createWorkspace({
      ...workspace,
      name: "Local workspace",
      serverSettings: {
        agent: {
          ...workspace.serverSettings.agent,
          identityFile: localIdentityFilePath,
        },
      },
    }));
    await runWithCurrentUser(userB, () => saveWorkspaceFromMesh(payload));
    const replicated = await runWithCurrentUser(userB, () => getWorkspace(workspace.id));
    expect(replicated?.serverSettings.agent.transport).toBe("ssh");
    if (replicated?.serverSettings.agent.transport === "ssh") {
      expect(replicated.serverSettings.agent.identityFile).toBe(localIdentityFilePath);
      expect(await Bun.file(localIdentityFilePath).text()).toBe(localIdentityFileContent);
    }
    const replicatedPayload = await runWithCurrentUser(
      userB,
      () => getWorkspaceMeshPayload(replicated!),
    );
    expect(replicatedPayload.identityFile).toEqual({ configured: true });
    expect(JSON.stringify(replicatedPayload)).not.toContain(localIdentityFileContent);
  });

  test("approves a pairing request into a link with both members", async () => {
    await setupDatabase();
    await seedUser("local-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const remoteNode = {
      nodeId: crypto.randomUUID(),
      publicKey: "-----BEGIN PUBLIC KEY-----\nremote\n-----END PUBLIC KEY-----",
      fingerprint: "sha256:remote-fingerprint",
    };
    const request = await createMeshPairingRequest({
      requestedNodeId: remoteNode.nodeId,
      requestedLocalUserId: "remote-user",
      requestedUsername: "remote",
      endpoint: "https://remote.example.test",
      transport: "https",
      publicKey: remoteNode.publicKey,
      fingerprint: remoteNode.fingerprint,
      nonce: crypto.randomUUID(),
      signature: "signature",
      targetLocalUserId: "local-user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect((await listPendingMeshPairingRequests("local-user")).map((item) => item.id)).toEqual([request.id]);

    const link = await approveMeshPairingRequest({
      requestId: request.id,
      approvingUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
    });
    const members = await listMeshLinkMembers(link.linkId);

    expect(link.localUserId).toBe("local-user");
    expect(link.activeNodeId).toBe(localNode.nodeId);
    expect(members.map((member) => member.nodeId).sort()).toEqual(
      [localNode.nodeId, remoteNode.nodeId].sort(),
    );
    expect(members.every((member) => member.status === "active")).toBe(true);

    const retriedApproval = await approveMeshPairingRequest({
      requestId: request.id,
      approvingUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
      linkId: "different-link-override",
    });
    expect(retriedApproval.linkId).toBe(link.linkId);

    const firstClaim = await claimMeshLinkForLocalUser({
      linkId: link.linkId,
      localUserId: "local-user",
      nodeId: localNode.nodeId,
      claimOrigin: "test",
    });
    expect(firstClaim.generation).toBe(1);
    expect((await getMeshLinkForUser(link.linkId, "local-user"))?.activeNodeId).toBe(localNode.nodeId);

    const secondClaim = await applyMeshLinkTakeover({
      linkId: link.linkId,
      nodeId: remoteNode.nodeId,
      generation: 2,
      claimedAt: new Date(Date.now() + 1_000).toISOString(),
      claimOrigin: "test-remote",
      signature: "signed-remote-claim",
    });
    expect(secondClaim.nodeId).toBe(remoteNode.nodeId);
    expect((await getMeshLinkForUser(link.linkId, "local-user"))?.takeoverGeneration).toBe(2);
    expect((await getActiveMeshLinkTakeover(link.linkId))?.signature).toBe("signed-remote-claim");
  });

  test("persists a competing takeover conflict before returning the domain error", async () => {
    await setupDatabase();
    await seedUser("local-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const remoteKeyPair = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const remoteNodeId = crypto.randomUUID();
    await saveMeshNode({
      nodeId: remoteNodeId,
      instanceName: "Remote",
      publicKey: remotePublicKey,
      fingerprint: getMeshNodeFingerprint(remotePublicKey),
      endpoint: "https://remote.example.test",
      transport: "https",
      status: "active",
    });
    const link = await createMeshLink({
      localUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
    });
    await mergeMeshLinkMember({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      localUserId: "remote-user",
      endpoint: "https://remote.example.test",
      transport: "https",
      status: "active",
      membershipGeneration: 1,
      publicKey: remotePublicKey,
      fingerprint: getMeshNodeFingerprint(remotePublicKey),
    });

    await expect(applyMeshLinkTakeover({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      generation: link.takeoverGeneration,
      claimedAt: new Date().toISOString(),
      claimOrigin: "remote",
      signature: "remote-signature",
    })).rejects.toMatchObject({ code: "mesh_takeover_conflict" });

    expect((await getMeshLinkById(link.linkId))?.status).toBe("conflict");
    expect(getDatabase().query(`
      SELECT status
      FROM mesh_link_claims
      WHERE link_id = ? AND node_id = ? AND generation = ?
    `).get(link.linkId, remoteNodeId, link.takeoverGeneration)).toEqual({ status: "conflict" });
  });

  test("lists only open conflicts on links owned by the Core caller", async () => {
    await setupDatabase();
    await seedUser("local-user");
    await seedUser("other-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const otherNodeId = crypto.randomUUID();
    const otherPublicKey = generateKeyPairSync("ed25519").publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    await saveMeshNode({
      nodeId: otherNodeId,
      instanceName: "Other",
      publicKey: otherPublicKey,
      fingerprint: getMeshNodeFingerprint(otherPublicKey),
      endpoint: "https://other.example.test",
      transport: "https",
      status: "active",
    });
    const localLink = await createMeshLink({
      localUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
    });
    const otherLink = await createMeshLink({
      localUserId: "other-user",
      localNodeId: otherNodeId,
      localNodeEndpoint: "https://other.example.test",
      localNodeTransport: "https",
    });
    const localConflict = await recordMeshSyncConflict({
      linkId: localLink.linkId,
      aggregateType: "workspace",
      aggregateId: "local-workspace",
      originNodeId: otherNodeId,
      remoteRevision: 1,
      basePayload: { version: 1 },
      localPayload: { version: 2 },
      remotePayload: { version: 3 },
    });
    await recordMeshSyncConflict({
      linkId: otherLink.linkId,
      aggregateType: "workspace",
      aggregateId: "other-workspace",
      originNodeId: localNode.nodeId,
      remoteRevision: 1,
      basePayload: { version: 1 },
      localPayload: { version: 2 },
      remotePayload: { version: 3 },
    });

    const conflicts = await meshManager.listOpenConflicts("local-user");
    expect(conflicts.map((conflict) => conflict.conflictId)).toEqual([localConflict.conflictId]);
    expect(conflicts[0]?.linkId).toBe(localLink.linkId);
  });

  test("preserves an existing link when a new node is approved on a target without local membership", async () => {
    await setupDatabase();
    await seedUser("new-node-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const remoteKeyPair = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const targetLinkId = crypto.randomUUID();
    const request = await createMeshPairingRequest({
      linkId: targetLinkId,
      requestedNodeId: crypto.randomUUID(),
      requestedLocalUserId: "existing-mesh-user",
      requestedUsername: "existing",
      endpoint: "https://existing.example.test",
      transport: "https",
      publicKey: remotePublicKey,
      fingerprint: getMeshNodeFingerprint(remotePublicKey),
      nonce: crypto.randomUUID(),
      signature: "signature",
      targetLocalUserId: "new-node-user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(request.linkId).toBe(targetLinkId);
    const approvedLink = await approveMeshPairingRequest({
      requestId: request.id,
      approvingUserId: "new-node-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://new-node.example.test",
      localNodeTransport: "https",
    });

    expect(approvedLink.linkId).toBe(targetLinkId);
    expect((await getMeshPairingRequest(request.id))?.linkId).toBe(targetLinkId);
  });

  test("accepts a signed pairing request idempotently", async () => {
    await setupDatabase();
    await seedUser("local-user");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const unsigned = {
      protocolVersion: 1 as const,
      requestId: crypto.randomUUID(),
      targetLocalUserId: "local-user",
      requestedNodeId: crypto.randomUUID(),
      requestedInstanceName: "Remote instance",
      requestedLocalUserId: "remote-user",
      requestedUsername: "remote",
      endpoint: "https://remote.example.test",
      transport: "https" as const,
      publicKey: publicKeyPem,
      fingerprint: getMeshNodeFingerprint(publicKeyPem),
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signature = sign(
      null,
      Buffer.from(buildMeshPairingRequestSigningPayload(unsigned), "utf8"),
      privateKey,
    ).toString("base64url");
    const envelope = { ...unsigned, signature };

    const first = await meshManager.receivePairingRequest(envelope);
    const second = await meshManager.receivePairingRequest(envelope);

    expect(first).toEqual(second);
    expect((await listPendingMeshPairingRequests("local-user")).map((item) => item.id)).toEqual([
      unsigned.requestId,
    ]);
  });

  test("applies a relayed takeover when the sync envelope has no members", async () => {
    await setupDatabase();
    await seedUser("local-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const remoteKeyPair = generateKeyPairSync("ed25519");
    const remoteEncryptionKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const remotePublicKey = remoteKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const remoteEncryptionPublicKey = remoteEncryptionKeyPair.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const remoteNodeId = crypto.randomUUID();
    const remoteFingerprint = getMeshNodeFingerprint(remotePublicKey);
    const request = await createMeshPairingRequest({
      requestedNodeId: remoteNodeId,
      requestedLocalUserId: "remote-user",
      requestedUsername: "remote",
      endpoint: "https://remote.example.test",
      transport: "https",
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      encryptionPublicKey: remoteEncryptionPublicKey,
      nonce: crypto.randomUUID(),
      signature: "signature",
      targetLocalUserId: "local-user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const link = await approveMeshPairingRequest({
      requestId: request.id,
      approvingUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
    });
    const takeoverUnsigned = {
      protocolVersion: 1 as const,
      linkId: link.linkId,
      senderNodeId: remoteNodeId,
      senderPublicKey: remotePublicKey,
      senderFingerprint: remoteFingerprint,
      generation: 2,
      claimedAt: new Date().toISOString(),
      claimOrigin: "relayed-test",
    };
    const takeoverSignature = sign(
      null,
      Buffer.from(buildMeshTakeoverSigningPayload(takeoverUnsigned), "utf8"),
      remoteKeyPair.privateKey,
    ).toString("base64url");
    const pushUnsigned = {
      protocolVersion: 1 as const,
      linkId: link.linkId,
      senderNodeId: remoteNodeId,
      senderPublicKey: remotePublicKey,
      senderFingerprint: remoteFingerprint,
      senderEncryptionPublicKey: remoteEncryptionPublicKey,
      nonce: crypto.randomUUID(),
      members: [],
      takeover: { ...takeoverUnsigned, signature: takeoverSignature },
      checkpoints: [],
    };
    const signature = sign(
      null,
      Buffer.from(buildMeshSyncPushSigningPayload(pushUnsigned), "utf8"),
      remoteKeyPair.privateKey,
    ).toString("base64url");

    await receiveMeshSyncPush({ ...pushUnsigned, signature });

    const updatedLink = await getMeshLinkById(link.linkId);
    expect(updatedLink?.activeNodeId).toBe(remoteNodeId);
    expect(updatedLink?.takeoverGeneration).toBe(2);
  });

  test("merges stale membership snapshots without creating conflicts", async () => {
    await setupDatabase();
    await seedUser("local-user");
    const localNode = await ensureLocalMeshNodeIdentity();
    const remoteKeyPair = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const remoteNodeId = crypto.randomUUID();
    const remoteFingerprint = getMeshNodeFingerprint(remotePublicKey);
    const request = await createMeshPairingRequest({
      requestedNodeId: remoteNodeId,
      requestedLocalUserId: "remote-user",
      requestedUsername: "remote",
      endpoint: "https://remote.example.test",
      transport: "https",
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      nonce: crypto.randomUUID(),
      signature: "signature",
      targetLocalUserId: "local-user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const link = await approveMeshPairingRequest({
      requestId: request.id,
      approvingUserId: "local-user",
      localNodeId: localNode.nodeId,
      localNodeEndpoint: "https://local.example.test",
      localNodeTransport: "https",
    });
    const thirdKeyPair = generateKeyPairSync("ed25519");
    const thirdPublicKey = thirdKeyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const thirdNodeId = crypto.randomUUID();
    await mergeMeshLinkMember({
      linkId: link.linkId,
      nodeId: thirdNodeId,
      localUserId: "third-user",
      endpoint: "https://third.example.test",
      transport: "https",
      status: "active",
      membershipGeneration: 1,
      publicKey: thirdPublicKey,
      fingerprint: getMeshNodeFingerprint(thirdPublicKey),
    });

    const staleSnapshot = (await getMeshLinkMembershipSnapshot(link.linkId))
      .filter((member) => member.nodeId !== thirdNodeId);
    await applyMeshCheckpoint(remoteNodeId, {
      checkpointId: crypto.randomUUID(),
      linkId: link.linkId,
      aggregateType: "mesh_membership",
      aggregateId: link.linkId,
      originNodeId: remoteNodeId,
      baseRevision: 0,
      targetRevision: 1,
      basePayload: null,
      payload: staleSnapshot,
      tombstone: false,
      createdAt: new Date().toISOString(),
    });

    expect(await listMeshLinkMembers(link.linkId)).toHaveLength(3);
    expect(await listOpenMeshSyncConflicts(link.linkId)).toHaveLength(0);
  });

});
