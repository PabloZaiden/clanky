import { afterEach, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  restartMeshNode,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
} from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";
import {
  createExecutionHostRuntimeSnapshot,
  type ExecutionHostRuntimeSnapshot,
} from "../../src/shared/execution-host";
import type {
  MeshControllerStatus,
  MeshWorkerRegistration,
  MeshWorkerStatus,
} from "../../src/shared/mesh";
import { MeshCommandExecutor } from "../../src/core/mesh-command-executor";
import { GitService } from "../../src/core/git";
import {
  executionPathsEqual,
  executionPathStyleForPlatform,
} from "../../src/core/execution-path";
import { runWithCurrentUser } from "../../src/context/user-context";
import { AcpBackend, MeshAcpTransport } from "../../src/backends/acp";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";

interface MeshHealthResponse {
  success: boolean;
  status: MeshControllerStatus;
}

interface ExecutionHostCommandResponse {
  executionHost: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

let nodes: ManagedMeshNode[] = [];

function expectRuntimeSnapshot(
  registration: MeshWorkerRegistration,
  expected: ExecutionHostRuntimeSnapshot,
): void {
  expect(registration.workerPlatform).toEqual(expected.platform);
  expect(registration.workerCapabilities).toEqual(expected.capabilities);
}

async function exerciseMeshAcpRuntime(
  registration: MeshWorkerRegistration,
  directory: string,
): Promise<void> {
  await runWithCurrentUser({
    id: registration.localUserId,
    username: "native-worker-owner",
    role: "owner",
    isOwner: true,
    isAdmin: true,
  }, async () => {
    const backend = new AcpBackend({
      transportLifecycle: new MeshAcpTransport(),
    });
    try {
      await backend.connect({
        mode: "spawn",
        provider: "copilot",
        directory,
        mesh: {
          workspaceId: "native-worker-acp-e2e",
          executionNodeId: registration.workerNodeId,
        },
      });
      const session = await backend.createSession({ directory });
      const response = await backend.sendPrompt(session.id, {
        parts: [{ type: "text", text: "Exercise native Mesh ACP" }],
      });
      expect(response.content.length).toBeGreaterThan(0);
    } finally {
      await backend.disconnect();
    }
  });
}

async function exerciseNativeWorkerOperations(
  registration: MeshWorkerRegistration,
  directory: string,
  platformOs: string,
): Promise<void> {
  const executor = new MeshCommandExecutor({
    workspaceId: "native-worker-operations-e2e",
    directory,
    executionNodeId: registration.workerNodeId,
    provider: "copilot",
    localUserId: registration.localUserId,
    pathStyle: executionPathStyleForPlatform(platformOs)!,
    capabilities: registration.workerCapabilities ?? {},
  });

  try {
    const filesDirectory = join(directory, "native-worker-files");
    const sourcePath = join(filesDirectory, "source.txt");
    const movedPath = join(filesDirectory, "moved.txt");
    expect(await executor.writeFile(sourcePath, "native worker file\n")).toBe(true);
    expect(await executor.readFile(sourcePath)).toBe("native worker file\n");
    expect(await executor.listDirectoryEntries(filesDirectory, {
      includeHidden: true,
    })).toEqual([{
      name: "source.txt",
      kind: "file",
      isSymbolicLink: false,
    }]);
    expect(await executor.movePath(sourcePath, movedPath)).toEqual({ success: true });
    expect(await executor.deletePath(movedPath, { kind: "file" })).toBe(true);
    expect(await executor.fileExists(movedPath)).toBe(false);

    const gitDirectory = join(directory, "native-worker-git");
    const trackedPath = join(gitDirectory, "tracked.txt");
    expect(await executor.writeFile(trackedPath, "initial\n")).toBe(true);
    for (const args of [
      ["init"],
      ["config", "user.name", "Clanky Native Worker E2E"],
      ["config", "user.email", "native-worker-e2e@clanky.invalid"],
    ]) {
      expect((await executor.execGit(gitDirectory, args, {
        scope: "repository",
      })).success).toBe(true);
    }
    const git = GitService.withExecutor(executor);
    expect(await git.isGitRepo(gitDirectory)).toBe(true);
    await git.stageAll(gitDirectory);
    await git.commit(gitDirectory, "test: initialize native worker repository");
    expect(await git.hasUncommittedChanges(gitDirectory)).toBe(false);
    expect(await executor.writeFile(trackedPath, "updated\n")).toBe(true);
    expect(await git.getChangedFiles(gitDirectory)).toEqual(["tracked.txt"]);

    const outputCommand = platformOs === "windows"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 2048 -join ''))",
          ],
        }
      : {
          command: "sh",
          args: ["-c", "printf '%2048s' '' | tr ' ' x"],
        };
    await expect(executor.exec(
      outputCommand.command,
      outputCommand.args,
      {
        cwd: directory,
        maxOutputBytes: 1_024,
      },
    )).rejects.toMatchObject({ code: "mesh_execution_result_too_large" });

    const markerPath = join(directory, "native-worker-cancel-started");
    const cancelCommand = platformOs === "windows"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[IO.File]::WriteAllText($env:CLANKY_NATIVE_E2E_MARKER, 'started'); Start-Sleep -Seconds 30",
          ],
        }
      : {
          command: "sh",
          args: [
            "-c",
            "printf started > \"$CLANKY_NATIVE_E2E_MARKER\"; sleep 30",
          ],
        };
    const cancellation = new AbortController();
    const pendingCancellation = executor.exec(
      cancelCommand.command,
      cancelCommand.args,
      {
        cwd: directory,
        timeout: 60_000,
        longRunning: true,
        signal: cancellation.signal,
        env: { CLANKY_NATIVE_E2E_MARKER: markerPath },
      },
    );
    await pollUntil(
      async () => await executor.fileExists(markerPath),
      (exists) => exists,
      {
        description: "native worker cancellation command to start",
        timeoutMs: 15_000,
      },
    );
    cancellation.abort();
    await expect(pendingCancellation).rejects.toMatchObject({
      code: "mesh_execution_aborted",
    });
  } finally {
    executor.close();
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const node of nodes.reverse()) {
    try {
      await stopMeshNode(node);
    } catch (error) {
      failures.push(error);
    }
  }
  nodes = [];
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to clean up native Mesh E2E processes");
  }
});

describe("native worker registration", () => {
  test("enrolls, executes through ACP, reports health, and reconnects after restart", async () => {
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({ role: "controller", command });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker",
      command,
      environment: {
        CLANKY_MOCK_ACP: "1",
        CLANKY_EMBEDDED_MOCK_ACP: "1",
      },
    });
    nodes.push(worker);

    await enrollMeshWorker(controller, worker);

    const expectedRuntime = createExecutionHostRuntimeSnapshot(
      process.platform,
      process.arch,
    );
    const registered = await pollUntil(
      async () => await meshJsonRequest<MeshControllerStatus>(
        controller,
        "/api/mesh/status",
      ),
      (response) => response.status === 200 && response.body.workers.length === 1,
      {
        description: "native worker registration",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const registration = registered.body.workers[0]!;
    expect(registration).toMatchObject({
      workerInstanceName: "worker-1",
      workerEndpoint: worker.baseUrl,
      workerTransport: "https",
      workerDirectory: worker.dataDir,
      workerAcceptRemoteExecution: true,
      grantStatus: "active",
      route: {
        kind: "direct",
        endpoint: worker.baseUrl,
        transport: "https",
        tlsTrust: "pinned",
      },
    });
    expectRuntimeSnapshot(registration, expectedRuntime);

    const workerStatus = await meshJsonRequest<MeshWorkerStatus>(
      worker,
      "/api/mesh/status",
    );
    expect(workerStatus.status).toBe(200);
    expect(workerStatus.body).toMatchObject({
      node: { nodeId: registration.workerNodeId },
      controllerCount: 1,
      execution: {
        directory: worker.dataDir,
        acceptRemoteExecution: true,
        ...expectedRuntime,
      },
    });

    const platformOs = expectedRuntime.platform!.os;
    const workingDirectoryProbe = platformOs === "windows"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write((Get-Location).Path)",
          ],
        }
      : {
          command: "pwd",
          args: ["-P"],
        };
    const execution = await pollUntil(
      async () => await meshJsonRequest<ExecutionHostCommandResponse>(
        controller,
        `/api/execution-hosts/mesh/${encodeURIComponent(registration.workerNodeId)}/exec`,
        {
          method: "POST",
          body: {
            command: workingDirectoryProbe.command,
            args: workingDirectoryProbe.args,
            cwd: worker.dataDir,
            timeoutMs: 5_000,
          },
        },
      ),
      (response) => response.status === 200 && response.body.success === true,
      {
        description: "native worker command execution",
        timeoutMs: 15_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const reportedDirectory = execution.body.stdout.trim();
    const canonicalWorkerDirectory = await realpath(worker.dataDir);
    const canonicalReportedDirectory = await realpath(reportedDirectory);
    expect(executionPathsEqual(
      canonicalReportedDirectory,
      canonicalWorkerDirectory,
      executionPathStyleForPlatform(platformOs)!,
    )).toBe(true);
    const previousDataDir = process.env["CLANKY_DATA_DIR"];
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = controller.dataDir;
    await initializeDatabase();
    try {
      await exerciseNativeWorkerOperations(
        registration,
        worker.dataDir,
        platformOs,
      );
      await exerciseMeshAcpRuntime(registration, worker.dataDir);
    } finally {
      closeDatabase();
      if (previousDataDir === undefined) {
        delete process.env["CLANKY_DATA_DIR"];
      } else {
        process.env["CLANKY_DATA_DIR"] = previousDataDir;
      }
    }

    const initialHealth = await pollUntil(
      async () => await meshJsonRequest<MeshHealthResponse>(
        controller,
        "/api/mesh/health",
        { method: "POST" },
      ),
      (response) => response.status === 200
        && response.body.success === true
        && typeof response.body.status.workers[0]?.lastSeenAt === "string",
      {
        description: "signed native worker health check",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const initialLastSeenAt = initialHealth.body.status.workers[0]!.lastSeenAt;
    expect(initialLastSeenAt).toBeString();

    await restartMeshNode(worker, 20_000);
    const reconnectedWorker = await pollUntil(
      async () => await meshJsonRequest<MeshWorkerStatus>(
        worker,
        "/api/mesh/status",
      ),
      (response) => response.status === 200
        && response.body.controllerCount === 1
        && response.body.node.nodeId === registration.workerNodeId,
      {
        description: "worker identity and controller grant after restart",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(reconnectedWorker.body.execution).toMatchObject(expectedRuntime);

    const healthAfterRestart = await pollUntil(
      async () => await meshJsonRequest<MeshHealthResponse>(
        controller,
        "/api/mesh/health",
        { method: "POST" },
      ),
      (response) => response.status === 200
        && response.body.success === true
        && response.body.status.workers[0]?.workerNodeId
          === registration.workerNodeId
        && response.body.status.workers[0]?.lastSeenAt !== null
        && response.body.status.workers[0]?.lastSeenAt !== initialLastSeenAt,
      {
        description: "controller health check after native worker restart",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(healthAfterRestart.body.status.workers[0]?.workerNodeId)
      .toBe(registration.workerNodeId);
    expectRuntimeSnapshot(
      healthAfterRestart.body.status.workers[0]!,
      expectedRuntime,
    );
  }, 120_000);
});
