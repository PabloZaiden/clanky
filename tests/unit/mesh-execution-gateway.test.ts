import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshExecutionSessionRequest } from "../../src/contracts/schemas/mesh-execution";
import {
  MeshExecutionGateway,
  assertMeshExecutionCwd,
  assertMeshExecutionPath,
} from "../../src/core/mesh-execution-gateway";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { getMeshNodeFingerprint, ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { revokeControllerGrant, saveControllerGrant } from "../../src/persistence/mesh";

describe("mesh execution path validation", () => {
  test("accepts arbitrary absolute host paths", () => {
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo"))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo/.clanky-worktrees/task-1"))
      .toBe("/workspaces/repo/.clanky-worktrees/task-1");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/tmp/other"))
      .toBe("/tmp/other");
    expect(assertMeshExecutionPath("/workspaces/repo", "/workspaces/repo/../other"))
      .toBe("/workspaces/other");
  });

  test("resolves relative paths against the execution root", () => {
    expect(assertMeshExecutionPath("/workspaces/repo", "relative/path"))
      .toBe("/workspaces/repo/relative/path");
    expect(assertMeshExecutionCwd("/workspaces/repo", "."))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "subdir"))
      .toBe("/workspaces/repo/subdir");
  });

  test("rejects NUL bytes", () => {
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/tmp/invalid\0path"))
      .toThrow();
    expect(() => assertMeshExecutionPath("/workspaces/repo\0invalid", "path"))
      .toThrow();
    expect(() => assertMeshExecutionPath("relative-root", "path"))
      .toThrow();
  });
});

describe("mesh asynchronous command lifecycle", () => {
  let dataDir: string;
  let workerDirectory: string;
  let gateway: MeshExecutionGateway;
  let controllerNodeId: string;
  let controllerPrivateKey: KeyObject;
  let controllerPublicKey: string;
  let controllerFingerprint: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-gateway-"));
    workerDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-worker-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
    await configureMeshRuntime({
      meshWorker: true,
      workerDirectory,
      workerExecutionEnabled: true,
    });

    const controllerKeys = generateKeyPairSync("ed25519");
    controllerPrivateKey = controllerKeys.privateKey;
    controllerPublicKey = controllerKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    controllerNodeId = "controller-node";
    controllerFingerprint = getMeshNodeFingerprint(controllerPublicKey);
    await saveControllerGrant({
      controllerNodeId,
      controllerInstanceName: "Test controller",
      controllerPublicKey,
      controllerFingerprint,
      controllerEncryptionPublicKey: null,
    });
    gateway = new MeshExecutionGateway();
  });

  afterEach(async () => {
    gateway.closeAll();
    await configureMeshRuntime({ meshWorker: false });
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(workerDirectory, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  async function createSession(workspaceId: string) {
    const workerIdentity = await ensureLocalMeshNodeIdentity();
    const unsigned: Omit<MeshExecutionSessionRequest, "signature"> = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      callerNodeId: controllerNodeId,
      callerPublicKey: controllerPublicKey,
      callerFingerprint: controllerFingerprint,
      callerEncryptionPublicKey: "test-encryption-key",
      targetNodeId: workerIdentity.nodeId,
      workspaceId,
      directory: workerDirectory,
      provider: "copilot",
      channel: "command-executor",
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    return await gateway.createSession({
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(buildMeshExecutionSessionSigningPayload(unsigned), "utf8"),
        controllerPrivateKey,
      ).toString("base64url"),
    });
  }

  async function waitForTerminal(
    session: Awaited<ReturnType<typeof createSession>>,
    jobId: string,
  ) {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let lastStatus = "running";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const snapshot = await gateway.getAsyncCommand(
        session.sessionId,
        session.sessionToken,
        jobId,
        crypto.randomUUID(),
        stdoutOffset,
        stderrOffset,
      );
      lastStatus = snapshot.status;
      stdoutOffset = snapshot.output?.nextStdoutOffset ?? stdoutOffset;
      stderrOffset = snapshot.output?.nextStderrOffset ?? stderrOffset;
      if (snapshot.status !== "running") {
        return snapshot;
      }
      await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for async command; last status: ${lastStatus}`);
  }

  test("runs, streams bounded output, cancels, and rejects a mismatched context", async () => {
    const session = await createSession("workspace-a");
    const started = await gateway.startAsyncCommand({
      protocolVersion: 1,
      action: "start",
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: crypto.randomUUID(),
      command: "/bin/sh",
      args: ["-c", "printf gateway-output"],
      cwd: workerDirectory,
      timeout: 5_000,
      maxOutputBytes: 1024,
    });
    const completed = await waitForTerminal(session, started.jobId);

    expect(completed.status).toBe("completed");
    expect(completed.output?.stdout).toBe("gateway-output");
    expect(completed.result?.stdout).toBe("gateway-output");
    expect(completed.result?.exitCode).toBe(0);

    const cancellable = await gateway.startAsyncCommand({
      protocolVersion: 1,
      action: "start",
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: crypto.randomUUID(),
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: workerDirectory,
      timeout: 60_000,
    });
    const cancelled = await gateway.cancelAsyncCommand(
      session.sessionId,
      session.sessionToken,
      cancellable.jobId,
      crypto.randomUUID(),
    );
    expect(cancelled.status).toBe("cancelled");

    const mismatchedSession = await createSession("workspace-b");
    await expect(gateway.getAsyncCommand(
      mismatchedSession.sessionId,
      mismatchedSession.sessionToken,
      started.jobId,
      crypto.randomUUID(),
    )).rejects.toMatchObject({ code: "mesh_execution_context_changed" });
  });

  test("cancels active commands when the controller grant is revoked", async () => {
    const session = await createSession("workspace-a");
    const started = await gateway.startAsyncCommand({
      protocolVersion: 1,
      action: "start",
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: crypto.randomUUID(),
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: workerDirectory,
      timeout: 60_000,
    });

    await revokeControllerGrant(controllerNodeId);
    await expect(gateway.getAsyncCommand(
      session.sessionId,
      session.sessionToken,
      started.jobId,
      crypto.randomUUID(),
    )).rejects.toMatchObject({ code: "mesh_peer_not_trusted" });

    await saveControllerGrant({
      controllerNodeId,
      controllerInstanceName: "Test controller",
      controllerPublicKey,
      controllerFingerprint,
      controllerEncryptionPublicKey: null,
    });
    const resumedSession = await createSession("workspace-a");
    const cancelled = await gateway.getAsyncCommand(
      resumedSession.sessionId,
      resumedSession.sessionToken,
      started.jobId,
      crypto.randomUUID(),
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error?.code).toBe("mesh_execution_aborted");
  });
});
