import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MeshExecutionRpcRequest,
  MeshExecutionSessionRequest,
} from "../../src/contracts/schemas/mesh-execution";
import {
  MeshExecutionGateway,
  assertPhysicalExecutionPath,
  assertMeshExecutionCwd,
  assertMeshExecutionPath,
  getMeshExecutionOperationCapability,
  resolveTrustedExecutionRoot,
} from "../../src/core/mesh-execution-gateway";
import { buildMeshExecutionSessionSigningPayload } from "../../src/core/mesh-protocol";
import { configureMeshRuntime } from "../../src/core/mesh-runtime";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { getMeshNodeFingerprint, ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { revokeControllerGrant, saveControllerGrant } from "../../src/persistence/mesh";

describe("mesh execution path validation", () => {
  test("keeps POSIX paths within the execution root", () => {
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo", "posix"))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "/workspaces/repo/.clanky-worktrees/task-1", "posix"))
      .toBe("/workspaces/repo/.clanky-worktrees/task-1");
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/tmp/other", "posix"))
      .toThrow();
    expect(() => assertMeshExecutionPath("/workspaces/repo", "/workspaces/repo/../other", "posix"))
      .toThrow();
  });

  test("resolves relative paths against the execution root", () => {
    expect(assertMeshExecutionPath("/workspaces/repo", "relative/path", "posix"))
      .toBe("/workspaces/repo/relative/path");
    expect(assertMeshExecutionCwd("/workspaces/repo", ".", "posix"))
      .toBe("/workspaces/repo");
    expect(assertMeshExecutionCwd("/workspaces/repo", "subdir", "posix"))
      .toBe("/workspaces/repo/subdir");
  });

  test("resolves Windows paths without allowing drive, casing, or separator escapes", () => {
    expect(assertMeshExecutionPath(
      "C:\\workspaces\\repo",
      "src\\index.ts",
      "windows",
    )).toBe("C:\\workspaces\\repo\\src\\index.ts");
    expect(assertMeshExecutionPath(
      "C:\\Workspaces\\Repo",
      "c:/workspaces/repo/src/index.ts",
      "windows",
    )).toBe("c:\\workspaces\\repo\\src\\index.ts");
    expect(() => assertMeshExecutionPath(
      "C:\\workspaces\\repo",
      "..\\other",
      "windows",
    )).toThrow();
    expect(() => assertMeshExecutionPath(
      "C:\\workspaces\\repo",
      "D:\\workspaces\\repo\\src\\index.ts",
      "windows",
    )).toThrow();
  });

  test("rejects NUL bytes", () => {
    expect(() => assertMeshExecutionCwd("/workspaces/repo", "/tmp/invalid\0path", "posix"))
      .toThrow();
    expect(() => assertMeshExecutionPath("/workspaces/repo\0invalid", "path", "posix"))
      .toThrow();
    expect(() => assertMeshExecutionPath("relative-root", "path", "posix"))
      .toThrow();
  });

  test("uses the canonical physical path after validating in-root symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "clanky-mesh-path-root-"));
    const target = join(root, "physical");
    await mkdir(target);
    await writeFile(join(target, "note.txt"), "inside\n");
    await symlink(target, join(root, "alias"));

    try {
      const trustedRoot = await resolveTrustedExecutionRoot(root, root, "posix");
      expect(await assertPhysicalExecutionPath(
        trustedRoot,
        "alias/note.txt",
      )).toBe(join(target, "note.txt"));
      expect(await assertPhysicalExecutionPath(
        trustedRoot,
        "alias/new.txt",
      )).toBe(join(target, "new.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("assigns capability versions by Mesh operation contract", () => {
    expect(getMeshExecutionOperationCapability("exec")).toEqual({
      id: "commandExecution",
      minimumVersion: 1,
    });
    expect(getMeshExecutionOperationCapability("readFile")).toEqual({
      id: "fileOperations",
      minimumVersion: 1,
    });
    expect(getMeshExecutionOperationCapability("movePath")).toEqual({
      id: "fileOperations",
      minimumVersion: 2,
    });
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
    let streamedStdout = "";
    let streamedStderr = "";
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
      if (snapshot.output) {
        streamedStdout += snapshot.output.stdout;
        streamedStderr += snapshot.output.stderr;
        stdoutOffset = snapshot.output.nextStdoutOffset;
        stderrOffset = snapshot.output.nextStderrOffset;
      }
      if (snapshot.status !== "running") {
        return {
          snapshot,
          streamedStdout,
          streamedStderr,
        };
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

    expect(completed.snapshot.status).toBe("completed");
    expect(completed.streamedStdout).toBe("gateway-output");
    expect(completed.snapshot.result?.stdout).toBe("gateway-output");
    expect(completed.snapshot.result?.exitCode).toBe(0);

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

  test("executes structured filesystem operations without allowing lexical or symlink escapes", async () => {
    const session = await createSession("workspace-files");
    const execute = async (
      operation: Omit<
        MeshExecutionRpcRequest,
        "protocolVersion" | "sessionId" | "sessionToken" | "requestId"
      >,
    ) => await gateway.execute({
      protocolVersion: 1,
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      requestId: crypto.randomUUID(),
      ...operation,
    });

    expect(await execute({
      operation: "writeFile",
      path: "notes/todo.txt",
      content: "portable filesystem\n",
    })).toBe(true);
    expect(await execute({
      operation: "fileExists",
      path: "notes/todo.txt",
    })).toBe(true);
    expect(await execute({
      operation: "directoryExists",
      path: "notes",
    })).toBe(true);
    expect(await execute({
      operation: "readFile",
      path: "notes/todo.txt",
    })).toBe("portable filesystem\n");
    expect(await execute({
      operation: "listDirectoryEntries",
      path: "notes",
      includeHidden: true,
    })).toEqual([{
      name: "todo.txt",
      kind: "file",
      isSymbolicLink: false,
    }]);
    expect(await execute({
      operation: "getFileMetadata",
      path: "notes/todo.txt",
      includeContentHash: true,
    })).toMatchObject({
      kind: "file",
      size: 20,
      isSymbolicLink: false,
    });
    expect(await execute({
      operation: "copyFile",
      sourcePath: "notes/todo.txt",
      destinationPath: "notes/copied.txt",
    })).toBe(true);
    expect(await execute({
      operation: "movePath",
      sourcePath: "notes/copied.txt",
      destinationPath: "notes/done.txt",
      overwrite: false,
    })).toEqual({ success: true });
    expect(await execute({
      operation: "deletePath",
      path: "notes/done.txt",
      kind: "file",
    })).toBe(true);
    expect(await execute({
      operation: "fileExists",
      path: "notes/done.txt",
    })).toBe(false);

    await expect(execute({
      operation: "readFile",
      path: "../outside.txt",
    })).rejects.toMatchObject({ code: "mesh_execution_path_invalid" });

    await Bun.write(join(dataDir, "outside.txt"), "outside\n");
    await symlink(dataDir, join(workerDirectory, "outside-link"));
    await expect(execute({
      operation: "readFile",
      path: "outside-link/outside.txt",
    })).rejects.toMatchObject({ code: "mesh_execution_path_invalid" });

    await symlink(join(dataDir, "future-directory"), join(workerDirectory, "dangling-link"));
    await expect(execute({
      operation: "writeFile",
      path: "dangling-link/new.txt",
      content: "outside\n",
    })).rejects.toMatchObject({ code: "mesh_execution_path_invalid" });
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
