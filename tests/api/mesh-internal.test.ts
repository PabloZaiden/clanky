import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshInternalRoutes } from "../../src/api/mesh-internal";
import {
  buildMeshEnrollmentRequestSigningPayload,
  buildMeshHealthCheckSigningPayload,
  buildMeshRevocationNoticeSigningPayload,
} from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { meshManager } from "../../src/core/mesh-manager";
import {
  ensureLocalMeshNodeIdentity,
  getMeshNodeFingerprint,
} from "../../src/persistence/mesh-node-identity";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  listWorkerRegistrations,
  saveControllerGrant,
} from "../../src/persistence/mesh";
import { saveControllerRelayPairing } from "../../src/persistence/controller-relay-pairing";
import {
  createExecutionHostRuntimeSnapshot,
  POSIX_EXECUTION_HOST_CAPABILITIES,
} from "../../src/shared/execution-host";
import {
  MESH_RUNTIME_SNAPSHOT_HEADER,
  MESH_RUNTIME_SNAPSHOT_VERSION,
} from "../../src/shared/mesh";
import { seedTestOwnerUser } from "../setup";
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-internal-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  process.env["CLANKY_PUBLIC_BASE_URL"] = "http://127.0.0.1:4100";
  await configureMeshRuntime({ meshWorker: false });
  await initializeDatabase();
  seedTestOwnerUser();
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  delete process.env["CLANKY_PUBLIC_BASE_URL"];
  await rm(dataDir, { recursive: true, force: true });
});

function createSigningIdentity() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    privateKey: keyPair.privateKey,
    publicKey,
    fingerprint: getMeshNodeFingerprint(publicKey),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Mesh internal controller-worker routes", () => {
  test("enrolls a signed worker with a single-use controller token", async () => {
    const created = await meshManager.createEnrollmentToken("admin", "Worker", 900);
    const worker = createSigningIdentity();
    const unsigned = {
      protocolVersion: 1 as const,
      workerNodeId: "worker-1",
      workerInstanceName: "Worker 1",
      workerEndpoint: "http://127.0.0.1:4200",
      workerTransport: "http" as const,
      workerPublicKey: worker.publicKey,
      workerFingerprint: worker.fingerprint,
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/srv/worker",
      workerPlatform: { os: "linux" as const, architecture: "x64" as const },
      workerCapabilities: {
        ...POSIX_EXECUTION_HOST_CAPABILITIES,
        retiredCapability: 1,
      },
      workerAcceptRemoteExecution: true as const,
      workerConfigRevision: 1,
      enrollmentToken: created.token,
      expectedControllerFingerprint: created.enrollment.controllerFingerprint,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(buildMeshEnrollmentRequestSigningPayload(unsigned)),
        worker.privateKey,
      ).toString("base64url"),
    };
    const route = meshInternalRoutes["/api/mesh/internal/enrollment"]!.POST!;
    const mismatchedTransport = await route(new Request("http://controller/api/mesh/internal/enrollment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "worker-1",
        "x-clanky-mesh-request-id": "worker-1",
      },
      body: JSON.stringify({
        ...body,
        workerTransport: "https",
      }),
    }), undefined as never);
    expect(mismatchedTransport!.status).toBe(400);
    const response = await route(new Request("http://controller/api/mesh/internal/enrollment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "worker-1",
        "x-clanky-mesh-request-id": "worker-1",
      },
      body: JSON.stringify(body),
    }), undefined as never);

    expect(response!.status).toBe(200);
    expect(await listWorkerRegistrations("admin")).toEqual([
      expect.objectContaining({
        workerPlatform: { os: "linux", architecture: "x64" },
        workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      }),
    ]);
    const replay = await route(new Request("http://controller/api/mesh/internal/enrollment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "worker-1",
        "x-clanky-mesh-request-id": "worker-1",
      },
      body: JSON.stringify(body),
    }), undefined as never);
    expect(replay!.status).toBe(410);
  });

  test("rejects signed relay enrollment outside an authenticated relay stream", async () => {
    const controller = await ensureLocalMeshNodeIdentity();
    const relay = createSigningIdentity();
    saveControllerRelayPairing({
      relayUrl: "https://relay.example.com",
      relayPublicKey: relay.publicKey,
      relayFingerprint: relay.fingerprint,
      controllerNodeId: controller.nodeId,
      controllerFingerprint: controller.fingerprint,
    });
    const created = await meshManager.createEnrollmentToken(
      "admin",
      "Relay worker",
      900,
      "relay",
    );
    const worker = createSigningIdentity();
    const unsigned = {
      protocolVersion: 2 as const,
      workerNodeId: "worker-relay-1",
      workerInstanceName: "Relay worker",
      workerPublicKey: worker.publicKey,
      workerFingerprint: worker.fingerprint,
      workerEncryptionPublicKey: "test-encryption-key",
      workerDirectory: "/srv/relay-worker",
      workerPlatform: null,
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      enrollmentToken: created.token,
      expectedControllerFingerprint: controller.fingerprint,
      route: {
        kind: "relay" as const,
        relayUrl: "https://relay.example.com",
        relayFingerprint: relay.fingerprint,
      },
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const route = meshInternalRoutes["/api/mesh/internal/enrollment"]!.POST!;
    const response = await route(new Request(
      "http://controller/api/mesh/internal/enrollment",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clanky-mesh-node-id": unsigned.workerNodeId,
          "x-clanky-mesh-request-id": unsigned.workerNodeId,
        },
        body: JSON.stringify({
          ...unsigned,
          signature: sign(
            null,
            Buffer.from(buildMeshEnrollmentRequestSigningPayload(unsigned)),
            worker.privateKey,
          ).toString("base64url"),
        }),
      },
    ), undefined as never);

    expect(response!.status).toBe(403);
    expect(await readJson(response!)).toMatchObject({
      error: "mesh_enrollment_relay_identity_mismatch",
    });
    expect(await listWorkerRegistrations("admin")).toEqual([]);
  });

  test("rejects a relay invitation used for direct protocol-v1 enrollment", async () => {
    const controller = await ensureLocalMeshNodeIdentity();
    const relay = createSigningIdentity();
    saveControllerRelayPairing({
      relayUrl: "https://relay.example.com",
      relayPublicKey: relay.publicKey,
      relayFingerprint: relay.fingerprint,
      controllerNodeId: controller.nodeId,
      controllerFingerprint: controller.fingerprint,
    });
    const created = await meshManager.createEnrollmentToken(
      "admin",
      "Relay worker",
      900,
      "relay",
    );
    const worker = createSigningIdentity();
    const unsigned = {
      protocolVersion: 1 as const,
      workerNodeId: "worker-direct-downgrade",
      workerInstanceName: "Downgrade worker",
      workerPublicKey: worker.publicKey,
      workerFingerprint: worker.fingerprint,
      workerEncryptionPublicKey: "test-encryption-key",
      workerDirectory: "/srv/worker",
      workerPlatform: null,
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      workerEndpoint: "http://127.0.0.1:8081",
      workerTransport: "http" as const,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      enrollmentToken: created.token,
      expectedControllerFingerprint: controller.fingerprint,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const response = await meshInternalRoutes[
      "/api/mesh/internal/enrollment"
    ]!.POST!(new Request("http://controller/api/mesh/internal/enrollment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": unsigned.workerNodeId,
        "x-clanky-mesh-request-id": unsigned.workerNodeId,
      },
      body: JSON.stringify({
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(buildMeshEnrollmentRequestSigningPayload(unsigned)),
          worker.privateKey,
        ).toString("base64url"),
      }),
    }), undefined as never);

    expect(response!.status).toBe(409);
    expect(await readJson(response!)).toMatchObject({
      error: "mesh_enrollment_relay_mismatch",
    });
    expect(await listWorkerRegistrations("admin")).toEqual([]);
  });

  test("negotiates current and pre-PR runtime health contracts", async () => {
    await configureMeshRuntime({ meshWorker: true, workerDirectory: dataDir });
    const controller = createSigningIdentity();
    await saveControllerGrant({
      controllerNodeId: "controller-1",
      controllerInstanceName: "Controller",
      controllerPublicKey: controller.publicKey,
      controllerFingerprint: controller.fingerprint,
      controllerEncryptionPublicKey: "test-encryption-key",
    });
    const runtimeSnapshot = createExecutionHostRuntimeSnapshot(
      process.platform,
      process.arch,
    );
    const unsigned = {
      protocolVersion: 1 as const,
      senderNodeId: "controller-1",
      senderPublicKey: controller.publicKey,
      senderFingerprint: controller.fingerprint,
      nonce: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
    };
    const route = meshInternalRoutes["/api/mesh/internal/health"]!.POST!;
    const response = await route(new Request("http://worker/api/mesh/internal/health", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "controller-1",
        "x-clanky-mesh-request-id": unsigned.nonce,
        [MESH_RUNTIME_SNAPSHOT_HEADER]: String(MESH_RUNTIME_SNAPSHOT_VERSION),
      },
      body: JSON.stringify({
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(buildMeshHealthCheckSigningPayload(unsigned)),
          controller.privateKey,
        ).toString("base64url"),
      }),
    }), undefined as never);

    expect(response!.status).toBe(200);
    expect(await readJson(response!)).toMatchObject({
      protocolVersion: 1,
      controllerNodeId: "controller-1",
      requestNonce: unsigned.nonce,
      workerDirectory: dataDir,
      workerPlatform: runtimeSnapshot.platform,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      workerCapabilities: runtimeSnapshot.capabilities,
      signature: expect.any(String),
    });

    const legacyUnsigned = {
      ...unsigned,
      nonce: crypto.randomUUID(),
    };
    const legacyResponse = await route(new Request("http://worker/api/mesh/internal/health", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "controller-1",
        "x-clanky-mesh-request-id": legacyUnsigned.nonce,
      },
      body: JSON.stringify({
        ...legacyUnsigned,
        signature: sign(
          null,
          Buffer.from(buildMeshHealthCheckSigningPayload(legacyUnsigned)),
          controller.privateKey,
        ).toString("base64url"),
      }),
    }), undefined as never);

    expect(legacyResponse!.status).toBe(200);
    const legacyBody = await readJson(legacyResponse!);
    expect(legacyBody).not.toHaveProperty("workerPlatform");
    expect(legacyBody["workerCapabilities"]).not.toHaveProperty("git");
    expect(legacyBody["workerCapabilities"]).not.toHaveProperty("managedWorktrees");
  });

  test("rejects signed controller operations targeting another worker", async () => {
    await configureMeshRuntime({ meshWorker: true, workerDirectory: dataDir });
    const worker = await ensureLocalMeshNodeIdentity();
    const controller = createSigningIdentity();
    await saveControllerGrant({
      controllerNodeId: "controller-1",
      controllerInstanceName: "Controller",
      controllerPublicKey: controller.publicKey,
      controllerFingerprint: controller.fingerprint,
      controllerEncryptionPublicKey: "test-encryption-key",
    });

    const revocation = {
      protocolVersion: 1 as const,
      controllerNodeId: "controller-1",
      workerNodeId: `${worker.nodeId}-other`,
      controllerPublicKey: controller.publicKey,
      controllerFingerprint: controller.fingerprint,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const revocationResponse = await meshInternalRoutes[
      "/api/mesh/internal/revocation"
    ]!.POST!(new Request("http://worker/api/mesh/internal/revocation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "controller-1",
        "x-clanky-mesh-request-id": "controller-1",
      },
      body: JSON.stringify({
        ...revocation,
        signature: sign(
          null,
          Buffer.from(buildMeshRevocationNoticeSigningPayload(revocation)),
          controller.privateKey,
        ).toString("base64url"),
      }),
    }), undefined as never);
    expect(revocationResponse!.status).toBe(400);
    expect(await readJson(revocationResponse!)).toMatchObject({
      error: "mesh_peer_target_invalid",
    });
    expect((await meshManager.getWorkerStatus()).controllerCount).toBe(1);
  });

  test("rejects execution requests whose identity headers do not match", async () => {
    await configureMeshRuntime({ meshWorker: true, workerDirectory: dataDir });
    const route = meshInternalRoutes["/api/mesh/internal/execution/session"]!.POST!;
    const response = await route(new Request("http://worker/api/mesh/internal/execution/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": "different",
        "x-clanky-mesh-request-id": "request-1",
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId: "request-1",
        callerNodeId: "controller-1",
        callerPublicKey: "key",
        callerFingerprint: "fingerprint",
        callerEncryptionPublicKey: "key",
        targetNodeId: "worker-1",
        workspaceId: "workspace-1",
        directory: "/workspace",
        provider: "opencode",
        channel: "command-executor",
        encryptedEnvironment: null,
        nonce: "nonce-1",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        signature: "signature",
      }),
    }), undefined as never);

    expect(response!.status).toBe(400);
    expect(await readJson(response!)).toMatchObject({ error: "mesh_peer_headers_invalid" });
  });
});
