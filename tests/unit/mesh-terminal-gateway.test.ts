import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTerminalSessionRequest } from "../../src/contracts/schemas/mesh-terminal";
import { DomainError } from "../../src/core/domain-error";
import { MeshTerminalGateway } from "../../src/core/mesh-terminal-gateway";
import { buildMeshTerminalSessionSigningPayload } from "../../src/core/mesh-terminal-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import {
  closeDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import {
  revokeControllerGrant,
  saveControllerGrant,
} from "../../src/persistence/mesh";
import {
  ensureLocalMeshNodeIdentity,
  signMeshPayload,
} from "../../src/persistence/mesh-node-identity";
import {
  MESH_TERMINAL_CAPABILITY,
  MESH_TERMINAL_PROTOCOL_VERSION,
  MESH_TERMINAL_SESSION_TTL_MS,
} from "../../src/shared/mesh-terminal";
import { pollUntil } from "../helpers/polling";

describe("MeshTerminalGateway relay lifecycle", () => {
  let dataDir: string;
  let workerDirectory: string;
  let gateway: MeshTerminalGateway;
  let openingSettled: boolean;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-terminal-gateway-"));
    workerDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-terminal-worker-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    closeDatabase();
    await initializeDatabase();
    await configureMeshRuntime({
      meshWorker: true,
      workerDirectory,
      workerExecutionEnabled: true,
    });
    gateway = new MeshTerminalGateway();
    openingSettled = false;
  });

  async function createSession(): Promise<{
    sessionId: string;
    sessionToken: string;
  }> {
    const identity = await ensureLocalMeshNodeIdentity();
    await saveControllerGrant({
      controllerNodeId: "controller-a",
      controllerInstanceName: "Test controller",
      controllerPublicKey: identity.publicKey,
      controllerFingerprint: identity.fingerprint,
      controllerEncryptionPublicKey: identity.encryptionPublicKey ?? null,
    });
    const unsigned: Omit<MeshTerminalSessionRequest, "signature"> = {
      protocolVersion: MESH_TERMINAL_PROTOCOL_VERSION,
      capability: MESH_TERMINAL_CAPABILITY,
      requestId: crypto.randomUUID(),
      callerNodeId: "controller-a",
      callerPublicKey: identity.publicKey,
      callerFingerprint: identity.fingerprint,
      callerEncryptionPublicKey: identity.encryptionPublicKey!,
      targetNodeId: identity.nodeId,
      workspaceId: "workspace-a",
      executionRoot: workerDirectory,
      directory: workerDirectory,
      provider: "copilot",
      terminalSessionId: "terminal-a",
      remoteSessionName: "clanky-terminal-a",
      connectionMode: "direct",
      useTmux: false,
      allowPersistentSessionCreate: false,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(
        Date.now() + MESH_TERMINAL_SESSION_TTL_MS - 1_000,
      ).toISOString(),
    };
    return await gateway.createSession({
      ...unsigned,
      signature: await signMeshPayload(
        buildMeshTerminalSessionSigningPayload(unsigned),
      ),
    });
  }

  afterEach(async () => {
    if (openingSettled) {
      await gateway.closeAll();
    }
    await configureMeshRuntime({ meshWorker: false });
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(workerDirectory, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  // This unit seam covers a lifecycle deadlock that requires a lease to become
  // invalid inside its own opening promise, before a terminal process exists.
  test("rejects an opening relay after its controller grant is revoked", async () => {
    const session = await createSession();
    await revokeControllerGrant("controller-a");

    const closeEvents: Array<{ code?: number; reason?: string }> = [];
    const socket = {
      send(_data: string): void {},
      close(code?: number, reason?: string): void {
        closeEvents.push({ code, reason });
      },
    };
    let openingOutcome: unknown;
    void gateway.open(
      socket,
      session.sessionId,
      session.sessionToken,
    ).then(
      () => {
        openingSettled = true;
        openingOutcome = null;
      },
      (error: unknown) => {
        openingSettled = true;
        openingOutcome = error;
      },
    );

    const error = await pollUntil(
      () => openingOutcome,
      (value) => value !== undefined,
      {
        description: "invalid Mesh terminal relay opening to settle",
        timeoutMs: 1_000,
      },
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("mesh_terminal_context_changed");
    await gateway.releaseSession(session.sessionId, session.sessionToken);
    expect(closeEvents).toEqual([{
      code: 1008,
      reason: "Mesh terminal authority changed",
    }]);
  });
});
