import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshInternalRoutes } from "../../src/api/mesh-internal";
import {
  buildMeshEnrollmentRequestSigningPayload,
  buildMeshHealthCheckSigningPayload,
} from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { meshManager } from "../../src/core/mesh-manager";
import { getMeshNodeFingerprint } from "../../src/persistence/mesh-node-identity";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  listWorkerRegistrations,
  saveControllerGrant,
} from "../../src/persistence/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
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
      workerDirectory: "/srv/worker",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
    expect((await listWorkerRegistrations("admin"))).toHaveLength(1);
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

  test("accepts signed health from one active controller grant in worker mode", async () => {
    await configureMeshRuntime({ meshWorker: true, workerDirectory: dataDir });
    const controller = createSigningIdentity();
    await saveControllerGrant({
      controllerNodeId: "controller-1",
      controllerInstanceName: "Controller",
      controllerPublicKey: controller.publicKey,
      controllerFingerprint: controller.fingerprint,
      controllerEncryptionPublicKey: null,
    });
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
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
      signature: expect.any(String),
    });
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
        nonce: "nonce-1",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        signature: "signature",
      }),
    }), undefined as never);

    expect(response!.status).toBe(400);
    expect(await readJson(response!)).toMatchObject({ error: "mesh_peer_headers_invalid" });
  });
});
