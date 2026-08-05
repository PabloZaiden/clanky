import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  createMeshLink,
  mergeMeshLinkMember,
  saveMeshNode,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
} from "../../src/persistence/mesh-node-identity";
import {
  getMeshSyncCursor,
  recordMeshCheckpoint,
} from "../../src/persistence/mesh-sync";
import { buildMeshSyncAckSigningPayload } from "../../src/core/mesh-protocol";
import { deliverMeshSyncOutbox } from "../../src/core/mesh-sync-manager";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-sync-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

function seedUser(id: string): void {
  const now = new Date().toISOString();
  getDatabase().run(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at,
      last_login_at, disabled_at
    ) VALUES (?, ?, 'user', 1, ?, ?, NULL, NULL)
  `, [id, id, now, now]);
}

describe("mesh sync manager", () => {
  test("retries failed and invalid deliveries before accepting a valid acknowledgement", async () => {
    seedUser("local-user");
    const localIdentity = await ensureLocalMeshNodeIdentity();
    const remoteSigningKeys = generateKeyPairSync("ed25519");
    const remotePublicKey = remoteSigningKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const remoteEncryptionKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const remoteEncryptionPublicKey = remoteEncryptionKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const remoteNodeId = crypto.randomUUID();
    const remoteFingerprint = getMeshNodeFingerprint(remotePublicKey);

    await saveMeshNode({
      nodeId: remoteNodeId,
      instanceName: "Remote instance",
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      encryptionPublicKey: remoteEncryptionPublicKey,
      endpoint: "http://127.0.0.1:4101",
      transport: "http",
      status: "active",
    });
    const link = await createMeshLink({
      localUserId: "local-user",
      localNodeId: localIdentity.nodeId,
      localNodeEndpoint: "http://127.0.0.1:4100",
      localNodeTransport: "http",
    });
    await mergeMeshLinkMember({
      linkId: link.linkId,
      nodeId: remoteNodeId,
      instanceName: "Remote instance",
      localUserId: "remote-user",
      endpoint: "http://127.0.0.1:4101",
      transport: "http",
      status: "active",
      membershipGeneration: 1,
      publicKey: remotePublicKey,
      fingerprint: remoteFingerprint,
      encryptionPublicKey: remoteEncryptionPublicKey,
    });

    const aggregateId = crypto.randomUUID();
    const checkpoint = await recordMeshCheckpoint({
      userId: "local-user",
      aggregateType: "ssh_server",
      aggregateId,
      payload: { name: "Remote-access server" },
      eligible: true,
    });
    expect(checkpoint).not.toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(async (
      _input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        linkId: string;
        nonce: string;
        checkpoints: Array<{
          checkpointId: string;
          aggregateType: "ssh_server";
          aggregateId: string;
          originNodeId: string;
          targetRevision: number;
        }>;
      };
      if (fetchCalls === 1) {
        throw new Error("peer unavailable");
      }

      const acknowledgements = body.checkpoints.map((item) => ({
        checkpointId: item.checkpointId,
        aggregateType: item.aggregateType,
        aggregateId: item.aggregateId,
        originNodeId: item.originNodeId,
        appliedRevision: item.targetRevision,
      }));
      const unsigned = {
        protocolVersion: 1 as const,
        linkId: body.linkId,
        senderNodeId: remoteNodeId,
        senderPublicKey: remotePublicKey,
        senderFingerprint: remoteFingerprint,
        senderEncryptionPublicKey: remoteEncryptionPublicKey,
        nonce: body.nonce,
        acknowledgements,
      };
      if (fetchCalls === 2) {
        return Response.json({ ...unsigned, signature: "invalid" });
      }
      const signature = sign(
        null,
        Buffer.from(buildMeshSyncAckSigningPayload(unsigned), "utf8"),
        remoteSigningKeys.privateKey,
      ).toString("base64url");
      return Response.json({ ...unsigned, signature });
    }, { preconnect: originalFetch.preconnect });

    const makeOutboxDue = (): void => {
      getDatabase().run(`
        UPDATE mesh_sync_outbox
        SET next_attempt_at = ?
        WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
      `, [new Date(0).toISOString(), remoteNodeId, "ssh_server", aggregateId]);
    };

    try {
      expect(await deliverMeshSyncOutbox()).toBe(0);
      expect(getDatabase().query(`
        SELECT status, attempts, last_error
        FROM mesh_sync_outbox
        WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
      `).get(remoteNodeId, "ssh_server", aggregateId)).toMatchObject({
        status: "failed",
        attempts: 1,
      });

      makeOutboxDue();
      expect(await deliverMeshSyncOutbox()).toBe(0);
      expect(getDatabase().query(`
        SELECT status, attempts
        FROM mesh_sync_outbox
        WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
      `).get(remoteNodeId, "ssh_server", aggregateId)).toMatchObject({
        status: "failed",
        attempts: 2,
      });

      makeOutboxDue();
      expect(await deliverMeshSyncOutbox()).toBe(1);
      expect(getDatabase().query(`
        SELECT 1
        FROM mesh_sync_outbox
        WHERE peer_node_id = ? AND aggregate_type = ? AND aggregate_id = ?
      `).get(remoteNodeId, "ssh_server", aggregateId)).toBeNull();
      expect(await getMeshSyncCursor(
        remoteNodeId,
        "ssh_server",
        aggregateId,
        localIdentity.nodeId,
      )).toBe(checkpoint!.targetRevision);
      expect(fetchCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
