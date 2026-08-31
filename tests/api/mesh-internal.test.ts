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

function createPairingEnvelope(endpoint = "http://127.0.0.1:4101") {
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
    endpoint,
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
  test("requires Mesh terminal session headers before WebSocket upgrade", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/terminal"]!.GET!;
    const response = await route(
      new Request("http://mesh.test/api/mesh/internal/terminal"),
      undefined as never,
    );

    expect(response?.status).toBe(401);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_terminal_session_invalid",
    });
  });

  test("rejects execution requests whose identity headers do not match the body", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/execution/session"]!.POST!;
    const response = await route(new Request("http://mesh.test/api/mesh/internal/execution/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "different-caller",
        "x-clanky-mesh-request-id": "request-1",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        linkId: "link-1",
        callerNodeId: "caller-1",
        callerPublicKey: "key",
        callerFingerprint: "fingerprint",
        callerEncryptionPublicKey: "key",
        targetNodeId: "target-1",
        workspaceId: "workspace-1",
        directory: "/workspace",
        provider: "opencode",
        channel: "command-executor",
        nonce: "nonce-1",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        signature: "signature",
      }),
    }), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_peer_headers_invalid",
    });
  });

  test("rejects execution sessions without a usable caller encryption key", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/execution/session"]!.POST!;
    const response = await route(new Request("http://mesh.test/api/mesh/internal/execution/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "caller-1",
        "x-clanky-mesh-request-id": "request-1",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        linkId: "link-1",
        callerNodeId: "caller-1",
        callerPublicKey: "key",
        callerFingerprint: "fingerprint",
        callerEncryptionPublicKey: "   ",
        targetNodeId: "target-1",
        workspaceId: "workspace-1",
        directory: "/workspace",
        provider: "opencode",
        channel: "command-executor",
        nonce: "nonce-1",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        signature: "signature",
      }),
    }), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_execution_encryption_key_invalid",
    });
  });

  test("requires the caller encryption key in the session schema", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/execution/session"]!.POST!;
    const response = await route(new Request("http://mesh.test/api/mesh/internal/execution/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "caller-1",
        "x-clanky-mesh-request-id": "request-1",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        linkId: "link-1",
        callerNodeId: "caller-1",
        callerPublicKey: "key",
        callerFingerprint: "fingerprint",
        targetNodeId: "target-1",
        workspaceId: "workspace-1",
        directory: "/workspace",
        provider: "opencode",
        channel: "command-executor",
        nonce: "nonce-1",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        signature: "signature",
      }),
    }), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "validation_error",
    });
  });

  test("rejects execution RPCs with mismatched session headers before dispatch", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/execution/rpc"]!.POST!;
    const response = await route(new Request("http://mesh.test/api/mesh/internal/execution/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-session-id": "session-a",
        "x-clanky-mesh-request-id": "request-a",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-b",
        sessionToken: "a".repeat(32),
        requestId: "request-a",
        operation: "exec",
        command: "printf",
        args: ["safe"],
      }),
    }), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_peer_headers_invalid",
    });
  });

  test("requires both session headers before upgrading the ACP relay", async () => {
    const route = meshInternalRoutes["/api/mesh/internal/execution/acp"]!.GET!;
    const response = await route(new Request("http://mesh.test/api/mesh/internal/execution/acp"), {
      params: {},
      server: { upgrade: () => true },
    } as never);

    expect(response?.status).toBe(401);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_execution_session_invalid",
    });
  });

  test("requires matching identity headers on every signed control route", async () => {
    const pairing = createPairingEnvelope();
    const linkId = crypto.randomUUID();
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
        path: "/api/mesh/internal/membership",
        payload: {
          protocolVersion: 1,
          linkId,
          senderNodeId: pairing.requestedNodeId,
          senderPublicKey: pairing.publicKey,
          senderFingerprint: pairing.fingerprint,
          nonce: crypto.randomUUID(),
          members: [{
            nodeId: pairing.requestedNodeId,
            instanceName: pairing.requestedInstanceName,
            localUserId: pairing.requestedLocalUserId,
            endpoint: pairing.endpoint,
            transport: pairing.transport,
            status: "active",
            membershipGeneration: 1,
            publicKey: pairing.publicKey,
            fingerprint: pairing.fingerprint,
          }],
          signature: "signature",
        },
        nodeId: pairing.requestedNodeId,
        requestId: "not-the-nonce",
      },
      {
        path: "/api/mesh/internal/health",
        payload: {
          protocolVersion: 1,
          linkId,
          senderNodeId: pairing.requestedNodeId,
          senderPublicKey: pairing.publicKey,
          senderFingerprint: pairing.fingerprint,
          nonce: crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          signature: "signature",
        },
        nodeId: pairing.requestedNodeId,
        requestId: "not-the-nonce",
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

  test("rejects pairing endpoints that contain credentials", async () => {
    const pairing = createPairingEnvelope("http://mesh-user:mesh-password@127.0.0.1:4101");
    const route = meshInternalRoutes["/api/mesh/internal/pairing-requests"]!.POST!;
    const response = await route(createInternalRequest(
      "/api/mesh/internal/pairing-requests",
      pairing,
      pairing.requestedNodeId,
      pairing.requestId,
    ), undefined as never);

    expect(response?.status).toBe(400);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_endpoint_invalid",
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
