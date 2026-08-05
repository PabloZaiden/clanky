import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { meshInternalRoutes } from "../../src/api/mesh-internal";
import { buildMeshPairingRequestSigningPayload } from "../../src/core/mesh-protocol";
import { getMeshNodeFingerprint } from "../../src/persistence/mesh-node-identity";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { saveMeshNode } from "../../src/persistence/mesh";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-internal-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

function createPairingEnvelope() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const unsigned = {
    protocolVersion: 1 as const,
    requestId: crypto.randomUUID(),
    targetLocalUserId: "target-user",
    requestedNodeId: crypto.randomUUID(),
    requestedInstanceName: "Remote instance",
    requestedLocalUserId: "remote-user",
    requestedUsername: "remote",
    endpoint: "http://127.0.0.1:4101",
    transport: "http" as const,
    publicKey,
    fingerprint: getMeshNodeFingerprint(publicKey),
    nonce: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const signature = sign(
    null,
    Buffer.from(buildMeshPairingRequestSigningPayload(unsigned), "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  return { ...unsigned, signature };
}

function createInternalRequest(
  path: string,
  payload: Record<string, unknown>,
  nodeId: string,
  requestId: string,
): Request {
  return new Request(`http://mesh.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clanky-mesh-node-id": nodeId,
      "x-clanky-mesh-request-id": requestId,
    },
    body: JSON.stringify(payload),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("mesh internal routes", () => {
  test("requires matching identity headers on every signed control route", async () => {
    const pairing = createPairingEnvelope();
    const linkId = crypto.randomUUID();
    const takeoverNodeId = crypto.randomUUID();
    const cases = [
      {
        path: "/api/mesh/internal/pairing-requests",
        payload: pairing,
        nodeId: pairing.requestedNodeId,
        requestId: pairing.requestId,
      },
      {
        path: "/api/mesh/internal/pairing-approvals",
        payload: {
          protocolVersion: 1,
          requestId: pairing.requestId,
          linkId,
          approvedByNodeId: pairing.requestedNodeId,
          approvedByInstanceName: "Approver",
          approvedByLocalUserId: "approver-user",
          activeNodeId: null,
          takeoverGeneration: 0,
          endpoint: pairing.endpoint,
          transport: pairing.transport,
          publicKey: pairing.publicKey,
          fingerprint: pairing.fingerprint,
          members: [],
          signature: "signature",
        },
        nodeId: pairing.requestedNodeId,
        requestId: pairing.requestId,
      },
      {
        path: "/api/mesh/internal/sync",
        payload: {
          protocolVersion: 1,
          linkId,
          senderNodeId: pairing.requestedNodeId,
          senderPublicKey: pairing.publicKey,
          senderFingerprint: pairing.fingerprint,
          nonce: crypto.randomUUID(),
          checkpoints: [{
            checkpointId: crypto.randomUUID(),
            linkId,
            aggregateType: "workspace",
            aggregateId: crypto.randomUUID(),
            originNodeId: pairing.requestedNodeId,
            baseRevision: 0,
            targetRevision: 1,
            basePayload: null,
            payload: { name: "remote" },
            tombstone: false,
            createdAt: new Date().toISOString(),
          }],
          signature: "signature",
        },
        nodeId: pairing.requestedNodeId,
        requestId: "not-the-nonce",
      },
      {
        path: "/api/mesh/internal/takeover",
        payload: {
          protocolVersion: 1,
          linkId,
          senderNodeId: takeoverNodeId,
          senderPublicKey: pairing.publicKey,
          senderFingerprint: pairing.fingerprint,
          generation: 1,
          claimedAt: new Date().toISOString(),
          claimOrigin: "test",
          signature: "signature",
        },
        nodeId: takeoverNodeId,
        requestId: `${linkId}:1:${takeoverNodeId}`,
      },
    ] as const;

    for (const testCase of cases) {
      const route = meshInternalRoutes[testCase.path as keyof typeof meshInternalRoutes];
      const handler = route?.POST;
      if (!handler) {
        throw new Error(`Missing POST handler for ${testCase.path}`);
      }
      const response = await handler(createInternalRequest(
        testCase.path,
        testCase.payload,
        "wrong-node",
        testCase.requestId,
      ), undefined as never);

      expect(response?.status).toBe(400);
      await expect(readJson(response!)).resolves.toMatchObject({
        error: "mesh_peer_headers_invalid",
      });
    }
  });

  test("rejects a pairing request with an invalid signature", async () => {
    const pairing = createPairingEnvelope();
    const route = meshInternalRoutes["/api/mesh/internal/pairing-requests"]!.POST!;
    const response = await route(createInternalRequest(
      "/api/mesh/internal/pairing-requests",
      { ...pairing, signature: "tampered" },
      pairing.requestedNodeId,
      pairing.requestId,
    ), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_peer_signature_invalid",
    });
  });

  test("rejects a pairing request from a revoked node", async () => {
    const pairing = createPairingEnvelope();
    await saveMeshNode({
      nodeId: pairing.requestedNodeId,
      instanceName: pairing.requestedInstanceName,
      publicKey: pairing.publicKey,
      fingerprint: pairing.fingerprint,
      endpoint: pairing.endpoint,
      transport: pairing.transport,
      status: "revoked",
    });
    const route = meshInternalRoutes["/api/mesh/internal/pairing-requests"]!.POST!;
    const response = await route(createInternalRequest(
      "/api/mesh/internal/pairing-requests",
      pairing,
      pairing.requestedNodeId,
      pairing.requestId,
    ), undefined as never);

    expect(response?.status).toBe(403);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_peer_revoked",
    });
  });

  test("accepts a valid signed pairing request", async () => {
    const pairing = createPairingEnvelope();
    const route = meshInternalRoutes["/api/mesh/internal/pairing-requests"]!.POST!;
    const response = await route(createInternalRequest(
      "/api/mesh/internal/pairing-requests",
      pairing,
      pairing.requestedNodeId,
      pairing.requestId,
    ), undefined as never);

    expect(response?.status).toBe(200);
    await expect(readJson(response!)).resolves.toMatchObject({
      requestId: pairing.requestId,
      status: "pending",
      fingerprint: pairing.fingerprint,
    });
  });
});
