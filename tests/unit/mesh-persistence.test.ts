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
import { receiveMeshSyncPush, deliverMeshSyncOutbox } from "../../src/core/mesh-sync-manager";
import { applyMeshCheckpoint } from "../../src/core/mesh-sync-service";
import {
  decryptMeshPayload,
  encryptMeshPayload,
} from "../../src/core/mesh-payload-crypto";
import { listOpenMeshSyncConflicts, recordMeshCheckpoint } from "../../src/persistence/mesh-sync";
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
import { runWithMeshReplicationSuppressed } from "../../src/core/mesh-sync-context";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

let dataDir: string | undefined;
const createdDataDirs: string[] = [];

async function setupDatabase(): Promise<void> {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-"));
  createdDataDirs.push(dataDir);
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
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
  while (createdDataDirs.length > 0) {
    const path = createdDataDirs.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
  dataDir = undefined;
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

  test("replicates standalone SSH server key material without exposing it publicly", async () => {
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
    expect(payload.keyPair.privateKey.length).toBeGreaterThan(100);

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
    expect(replicated?.publicKey).toEqual({
      algorithm: payload.keyPair.algorithm,
      publicKey: payload.keyPair.publicKey,
      fingerprint: payload.keyPair.fingerprint,
      version: payload.keyPair.version,
      createdAt: payload.keyPair.createdAt,
    });
  });

  test("replicates SSH workspace identity files into node-local managed paths", async () => {
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
    expect(payload.identityFile).toEqual({
      configured: true,
      content: identityFileContent,
    });

    await useNodeDatabase(nodeB.dataDir, "user-b");
    await runWithCurrentUser(userB, () => saveWorkspaceFromMesh(payload));
    const replicated = await runWithCurrentUser(userB, () => getWorkspace(workspace.id));
    expect(replicated?.serverSettings.agent.transport).toBe("ssh");
    if (replicated?.serverSettings.agent.transport === "ssh") {
      expect(replicated.serverSettings.agent.identityFile).toContain(
        join(nodeB.dataDir, "mesh", "workspace-identity-files"),
      );
      expect(await Bun.file(replicated.serverSettings.agent.identityFile!).text()).toBe(identityFileContent);
    }
    const replicatedPayload = await runWithCurrentUser(
      userB,
      () => getWorkspaceMeshPayload(replicated!),
    );
    expect(replicatedPayload.identityFile).toEqual({
      configured: true,
      content: identityFileContent,
    });
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

  test("completes a two-sided pairing handshake and remains idempotent", async () => {
    const nodeA = await createNodeDatabase("user-a");
    const nodeC = await createNodeDatabase("user-c");
    const originalFetch = globalThis.fetch;

    const mockFetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/api/mesh/internal/pairing-requests")) {
        await useNodeDatabase(nodeA.dataDir, "user-a");
        const result = await meshManager.receivePairingRequest(body);
        await useNodeDatabase(nodeC.dataDir, "user-c");
        return Response.json(result);
      }
      if (url.endsWith("/api/mesh/internal/pairing-approvals")) {
        await useNodeDatabase(nodeC.dataDir, "user-c");
        const result = await meshManager.receivePairingApproval(body);
        await useNodeDatabase(nodeA.dataDir, "user-a");
        return Response.json(result);
      }
      if (url.endsWith("/api/mesh/internal/sync")) {
        await useNodeDatabase(nodeA.dataDir, "user-a");
        const result = await receiveMeshSyncPush(body);
        await useNodeDatabase(nodeC.dataDir, "user-c");
        return Response.json(result);
      }
      throw new Error(`Unexpected mesh test URL: ${url}`);
    }, { preconnect: originalFetch.preconnect });
    globalThis.fetch = mockFetch;

    try {
      await useNodeDatabase(nodeC.dataDir, "user-c");
      const outgoing = await meshManager.startPairing(
        "user-c",
        "user-c",
        { targetEndpoint: "http://127.0.0.1:4100" },
        "http://127.0.0.1:4101/api/mesh/status",
      );
      const request = outgoing.pendingPairingRequests[0];
      expect(request?.direction).toBe("outgoing");
      expect(request?.status).toBe("pending");

      await useNodeDatabase(nodeA.dataDir, "user-a");
      const pendingAtA = (await meshManager.getStatus("user-a")).pendingPairingRequests;
      expect(pendingAtA).toHaveLength(1);
      const approvedAtA = await meshManager.approvePairingRequest(
        "user-a",
        pendingAtA[0]!.id,
        {},
        "http://127.0.0.1:4100/api/mesh/status",
      );
      expect(approvedAtA.links).toHaveLength(1);

      await useNodeDatabase(nodeC.dataDir, "user-c");
      const pendingAtC = (await meshManager.getStatus("user-c")).pendingPairingRequests;
      expect(pendingAtC[0]?.remoteApproval?.fingerprint).toBe(nodeA.identity.fingerprint);
      const completedAtC = await meshManager.completePairing(
        "user-c",
        pendingAtC[0]!.id,
        { fingerprint: nodeA.identity.fingerprint },
        "http://127.0.0.1:4101/api/mesh/status",
      );
      expect(completedAtC.links).toHaveLength(1);
      expect(completedAtC.links[0]!.members).toHaveLength(2);
      expect(completedAtC.links[0]!.members.map((member) => member.nodeId).sort()).toEqual(
        [nodeA.identity.nodeId, nodeC.identity.nodeId].sort(),
      );
      expect((await listMeshNodes()).every((node) => node.status === "active")).toBe(true);

      const repeated = await meshManager.completePairing(
        "user-c",
        pendingAtC[0]!.id,
        { fingerprint: nodeA.identity.fingerprint },
        "http://127.0.0.1:4101/api/mesh/status",
      );
      expect(repeated.links[0]?.linkId).toBe(completedAtC.links[0]?.linkId);

      await useNodeDatabase(nodeA.dataDir, "user-a");
      const statusAtA = await meshManager.getStatus("user-a");
      expect(statusAtA.links[0]?.linkId).toBe(completedAtC.links[0]?.linkId);
      expect(statusAtA.links[0]?.members).toHaveLength(2);

      const userC: CurrentUser = {
        id: "user-c",
        username: "user-c",
        role: "user",
        isOwner: false,
        isAdmin: false,
      };
      const workspace = {
        id: crypto.randomUUID(),
        name: "Remote workspace",
        directory: "/remote/workspace",
        serverSettings: {
          agent: {
            provider: "opencode" as const,
            transport: "ssh" as const,
            hostname: "remote.example",
            port: 22,
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await useNodeDatabase(nodeC.dataDir, "user-c");
      await runWithCurrentUser(userC, () => runWithMeshReplicationSuppressed(
        () => createWorkspace(workspace),
      ));
      const checkpoint = await recordMeshCheckpoint({
        userId: "user-c",
        aggregateType: "workspace",
        aggregateId: workspace.id,
        payload: workspace,
      });
      expect(checkpoint).not.toBeNull();
      const delivered = await deliverMeshSyncOutbox();
      if (delivered === 0) {
        console.log(getDatabase().query("SELECT peer_node_id, status, last_error FROM mesh_sync_outbox").all());
      }
      expect(delivered).toBeGreaterThan(0);

      await useNodeDatabase(nodeA.dataDir, "user-a");
      const replicatedWorkspace = await runWithCurrentUser(
        { ...userC, id: "user-a", username: "user-a" },
        () => getWorkspace(workspace.id),
      );
      expect(replicatedWorkspace?.name).toBe(workspace.name);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
