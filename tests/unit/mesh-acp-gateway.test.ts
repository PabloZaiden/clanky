import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshExecutionSessionRequest } from "../../src/contracts/schemas/mesh-execution";
import { MeshAcpGateway } from "../../src/core/mesh-acp-gateway";
import { meshExecutionGateway } from "../../src/core/mesh-execution-gateway";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../../src/persistence/mesh-node-identity";
import { revokeControllerGrant, saveControllerGrant } from "../../src/persistence/mesh";
import {
  MESH_ACP_CHANNEL,
  MESH_ACP_SESSION_TTL_MS,
} from "../../src/shared/mesh-execution";

describe("MeshAcpGateway relay lifecycle", () => {
  let dataDir: string;
  let workerDirectory: string;
  let gateway: MeshAcpGateway;
  let workerNodeId: string;
  let controllerPublicKey: string;
  let controllerFingerprint: string;
  let originalMockAcp: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-acp-gateway-"));
    workerDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-acp-worker-"));
    originalMockAcp = process.env["CLANKY_MOCK_ACP"];
    process.env["CLANKY_DATA_DIR"] = dataDir;
    process.env["CLANKY_MOCK_ACP"] = "true";
    closeDatabase();
    await initializeDatabase();
    await configureMeshRuntime({
      meshWorker: true,
      workerDirectory,
      workerExecutionEnabled: true,
    });
    const identity = await ensureLocalMeshNodeIdentity();
    workerNodeId = identity.nodeId;
    controllerPublicKey = identity.publicKey;
    controllerFingerprint = identity.fingerprint;
    await saveControllerGrant({
      controllerNodeId: "controller-a",
      controllerInstanceName: "Test controller",
      controllerPublicKey,
      controllerFingerprint,
      controllerEncryptionPublicKey: identity.encryptionPublicKey ?? null,
    });
    gateway = new MeshAcpGateway();
  });

  afterEach(async () => {
    await gateway.closeAll();
    await revokeControllerGrant("controller-a");
    await configureMeshRuntime({ meshWorker: false });
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    if (originalMockAcp === undefined) {
      delete process.env["CLANKY_MOCK_ACP"];
    } else {
      process.env["CLANKY_MOCK_ACP"] = originalMockAcp;
    }
    await rm(workerDirectory, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<{
    sessionId: string;
    sessionToken: string;
  }> {
    const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      callerNodeId: "controller-a",
      callerPublicKey: controllerPublicKey,
      callerFingerprint: controllerFingerprint,
      callerEncryptionPublicKey: controllerPublicKey,
      targetNodeId: workerNodeId,
      workspaceId: "workspace-a",
      directory: workerDirectory,
      provider: "copilot",
      channel: MESH_ACP_CHANNEL,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + MESH_ACP_SESSION_TTL_MS - 1_000).toISOString(),
    };
    const session = await meshExecutionGateway.createSession({
      ...unsigned,
      signature: await signMeshPayload(buildMeshExecutionSessionSigningPayload(unsigned)),
    });
    return {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
    };
  }

  test("keeps the execution session valid when opening a new relay", async () => {
    const session = await createSession();
    const closeEvents: Array<{ code?: number; reason?: string }> = [];
    const socket = {
      send(_data: string): void {},
      close(code?: number, reason?: string): void {
        closeEvents.push({ code, reason });
      },
    };

    await gateway.open(socket, session.sessionId, session.sessionToken);
    await expect(
      gateway.renew(session.sessionId, session.sessionToken),
    ).resolves.toBeGreaterThan(Date.now());
    expect(closeEvents).toEqual([]);
  });
});
