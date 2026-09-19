import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import { CommandExecutorImpl } from "../../src/core/remote-command-executor";
import { GitCommandError, GitService } from "../../src/core/git";
import { ensurePlanningDirectory } from "../../src/core/planning-directory";
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
  test("runs Git and managed worktree paths on the native host", async () => {
    const root = await mkdtemp(join(tmpdir(), "clanky-native-git-"));
    const repoDirectory = join(root, "repository with spaces");
    const configuredRepoDirectory = relative(process.cwd(), repoDirectory);
    const executor = new CommandExecutorImpl({
      provider: "local",
      directory: configuredRepoDirectory,
    });
    const git = GitService.withExecutor(executor);

    try {
      expect(await executor.writeFile(
        join(repoDirectory, "tracked.txt"),
        "initial\n",
      )).toBe(true);
      await expect(git.hasStagedChanges(configuredRepoDirectory)).rejects.toBeInstanceOf(
        GitCommandError,
      );
      for (const args of [
        ["init", repoDirectory],
        ["-C", repoDirectory, "config", "user.name", "Clanky Native E2E"],
        ["-C", repoDirectory, "config", "user.email", "native-e2e@clanky.invalid"],
      ]) {
        const result = await executor.exec("git", args, { cwd: root });
        expect(result.success).toBe(true);
      }

      expect(await executor.getExecutionDirectory()).toBe(repoDirectory);
      expect(await git.isGitRepo(configuredRepoDirectory)).toBe(true);
      const planningDirectory = await ensurePlanningDirectory(
        executor,
        configuredRepoDirectory,
      );
      expect(await executor.directoryExists(planningDirectory)).toBe(true);
      expect(await executor.listDirectory(planningDirectory, {
        includeHidden: true,
      })).toEqual([]);
      const currentBranch = await git.getCurrentBranch(configuredRepoDirectory);
      expect(currentBranch.length).toBeGreaterThan(0);

      await git.stageAll(configuredRepoDirectory);
      await git.commit(configuredRepoDirectory, "test: initialize native repository");
      expect(await git.hasUncommittedChanges(configuredRepoDirectory)).toBe(false);
      expect(await git.getLocalBranches(configuredRepoDirectory)).toEqual([
        { name: currentBranch, current: true },
      ]);

      expect(await executor.writeFile(
        join(repoDirectory, "tracked.txt"),
        "updated\n",
      )).toBe(true);
      expect(await git.getChangedFiles(configuredRepoDirectory)).toEqual(["tracked.txt"]);

      const worktreePath = await git.getManagedWorktreePath(
        configuredRepoDirectory,
        "native-e2e",
      );
      await git.createWorktree(
        configuredRepoDirectory,
        worktreePath,
        "native-e2e",
        currentBranch,
      );
      expect(await git.worktreeExists(configuredRepoDirectory, worktreePath)).toBe(true);

      await git.removeWorktree(configuredRepoDirectory, worktreePath, { force: true });
      expect(await executor.directoryExists(worktreePath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

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

    const execution = await pollUntil(
      async () => await meshJsonRequest<ExecutionHostCommandResponse>(
        controller,
        `/api/execution-hosts/mesh/${encodeURIComponent(registration.workerNodeId)}/exec`,
        {
          method: "POST",
          body: {
            command: "pwd",
            args: [],
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
    expect(execution.body.stdout.trim()).toBe(worker.dataDir);
    const previousDataDir = process.env["CLANKY_DATA_DIR"];
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = controller.dataDir;
    await initializeDatabase();
    try {
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
