import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshExecutionSessionRequest } from "../../src/contracts/schemas/mesh-execution";
import {
  MeshExecutionGateway,
  type MeshExecutionSessionResponse,
} from "../../src/core/mesh-execution-gateway";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { getMeshNodeFingerprint, ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { revokeControllerGrant, saveControllerGrant } from "../../src/persistence/mesh";
import { signMeshPayload } from "../../src/persistence/mesh-node-identity";
import {
  MESH_ACP_CHANNEL,
  MESH_ACP_SESSION_TTL_MS,
} from "../../src/shared/mesh-execution";

/**
 * This lifecycle contract is isolated so concurrent gateway tests cannot share
 * the session database while the expiry timer is being replaced.
 */
describe("MeshExecutionGateway ACP session renewal", () => {
  let dataDir: string;
  let workerNodeId: string;
  let gateway: MeshExecutionGateway;
  let controllerPublicKey: string;
  let controllerFingerprint: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-session-renewal-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    closeDatabase();
    await initializeDatabase();
    await configureMeshRuntime({
      meshWorker: true,
      workerDirectory: "/tmp",
      workerExecutionEnabled: true,
    });
    const identity = await ensureLocalMeshNodeIdentity();
    workerNodeId = identity.nodeId;
    controllerPublicKey = identity.publicKey;
    controllerFingerprint = getMeshNodeFingerprint(controllerPublicKey);
    await saveControllerGrant({
      controllerNodeId: "controller-a",
      controllerInstanceName: "Test controller",
      controllerPublicKey,
      controllerFingerprint,
      controllerEncryptionPublicKey: null,
    });
    gateway = new MeshExecutionGateway();
  });

  afterEach(async () => {
    gateway.closeAll();
    await revokeControllerGrant("controller-a");
    await configureMeshRuntime({ meshWorker: false });
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<{
    request: MeshExecutionSessionRequest;
    response: MeshExecutionSessionResponse;
  }> {
    const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      callerNodeId: "controller-a",
      callerPublicKey: controllerPublicKey,
      callerFingerprint: controllerFingerprint,
      callerEncryptionPublicKey: "test-encryption-key",
      targetNodeId: workerNodeId,
      workspaceId: "workspace-a",
      directory: "/tmp/workspace-a",
      provider: "copilot",
      channel: MESH_ACP_CHANNEL,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + MESH_ACP_SESSION_TTL_MS - 1_000).toISOString(),
    };
    const request: MeshExecutionSessionRequest = {
      ...unsigned,
      signature: await signMeshPayload(buildMeshExecutionSessionSigningPayload(unsigned)),
    };

    const response = await gateway.createSession(request);
    return { request, response };
  }

  test("renews an active ACP session and rejects an invalid token", async () => {
    const { request, response } = await createSession();
    const renewedExpiresAt = await gateway.renewSession(
      response.sessionId,
      response.sessionToken,
      MESH_ACP_CHANNEL,
    );

    expect(renewedExpiresAt).toBeGreaterThan(Date.parse(request.expiresAt));
    await expect(gateway.renewSession(
      response.sessionId,
      "invalid-session-token",
      MESH_ACP_CHANNEL,
    )).rejects.toMatchObject({ code: "mesh_execution_session_invalid" });
  });
});
