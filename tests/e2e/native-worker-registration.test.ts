import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  restartMeshNode,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
  type MeshJsonResponse,
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
import { MeshCommandExecutor } from "../../src/core/mesh-command-executor";
import {
  executionPathsEqual,
  executionPathStyleForPlatform,
} from "../../src/core/execution-path";
import { runWithCurrentUser } from "../../src/context/user-context";
import { openPreviewTcpForward } from "../../src/core/preview-tcp-forward";
import { openTcpTunnel, type TcpTunnel } from "../../src/core/tcp-tunnel";
import { MeshInteractiveTerminalConnection } from "../../src/core/terminal/mesh-terminal-connection";
import type {
  ExecutionHostBinding,
  ExecutionHostDescriptor,
} from "../../src/shared/execution-host";
import { AcpBackend, MeshAcpTransport } from "../../src/backends/acp";
import type { AgentEvent } from "../../src/backends/types";
import {
  closeDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import {
  buildTerminalCwdProbe,
  buildTerminalResizeProbe,
} from "../helpers/terminal-resize-probe";
import {
  MeshTerminalSessionCloseRequestSchema,
  type MeshTerminalSessionCloseRequest,
} from "../../src/contracts/schemas";

interface MeshHealthResponse {
  success: boolean;
  status: MeshControllerStatus;
}

interface CapturedTerminalRelease {
  url: string;
  request: MeshTerminalSessionCloseRequest;
  tls?: Bun.TLSOptions;
}

interface FileWriteResponse {
  success: true;
  file: {
    path: string;
    versionToken: string;
  };
}

interface FileListResponse {
  directory: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
  }>;
}

interface FileReadResponse {
  content: string;
  file: {
    path: string;
  };
}

interface FileMutationResponse {
  success: true;
  file?: {
    path: string;
    versionToken: string;
  };
  deletedPath?: string;
}

interface FileUploadResponse {
  uploadId: string;
}

let nodes: ManagedMeshNode[] = [];

function expectRuntimeSnapshot(
  registration: MeshWorkerRegistration,
  expected: ExecutionHostRuntimeSnapshot,
): void {
  expect(registration.workerPlatform).toEqual(expected.platform);
  expect(registration.workerCapabilities).toEqual(expected.capabilities);
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

async function nextAgentEvent(
  stream: { next(): Promise<AgentEvent | null> },
  timeoutMs = 10_000,
): Promise<AgentEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const event = await Promise.race([
      stream.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the next ACP event")),
          timeoutMs,
        );
      }),
    ]);
    if (!event) {
      throw new Error("The ACP event stream closed before the expected event");
    }
    return event;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
      expect(response.content).toContain("Mock ACP");

      const stream = await backend.subscribeToEvents(session.id);
      try {
        await backend.sendPromptAsync(session.id, {
          parts: [{ type: "text", text: "[slow] cancel native Mesh ACP" }],
        });
        expect(await nextAgentEvent(stream)).toMatchObject({
          type: "session.status",
          status: "busy",
        });
        await backend.abortSession(session.id);
      } finally {
        stream.close();
      }
    } finally {
      await backend.disconnect();
    }

    const reconnectedBackend = new AcpBackend({
      transportLifecycle: new MeshAcpTransport(),
    });
    try {
      await reconnectedBackend.connect({
        mode: "spawn",
        provider: "copilot",
        directory,
        mesh: {
          workspaceId: "native-worker-acp-reconnect-e2e",
          executionNodeId: registration.workerNodeId,
        },
      });
      expect(reconnectedBackend.isConnected()).toBe(true);
    } finally {
      await reconnectedBackend.disconnect();
    }
  });
}

async function exerciseMeshTerminal(
  registration: MeshWorkerRegistration,
  executionRoot: string,
  directory: string,
  platformOs: "linux" | "darwin" | "windows",
  options: {
    legacyRelease?: boolean;
  } = {},
): Promise<void> {
  await runWithCurrentUser({
    id: registration.localUserId,
    username: "native-worker-owner",
    role: "owner",
    isOwner: true,
    isAdmin: true,
  }, async () => {
    const output: string[] = [];
    const errors: Error[] = [];
    const windows = platformOs === "windows";
    let capturedRelease: CapturedTerminalRelease | undefined;
    const releaseAwareFetch: typeof globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          init?.method === "DELETE"
          && new URL(url).pathname.endsWith("/api/mesh/internal/terminal/session")
        ) {
          const request = MeshTerminalSessionCloseRequestSchema.parse(
            JSON.parse(String(init.body)),
          );
          capturedRelease = {
            url,
            request,
            ...("tls" in init && init.tls ? { tls: init.tls } : {}),
          };
          if (options.legacyRelease) {
            return Response.json(
              { message: "Method not allowed" },
              { status: 405 },
            );
          }
        }
        return await globalThis.fetch(input, init);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const connection = new MeshInteractiveTerminalConnection({
      workspaceId: "native-worker-terminal-e2e",
      executionRoot,
      directory,
      executionNodeId: registration.workerNodeId,
      provider: "copilot",
      terminalSessionId: crypto.randomUUID(),
      remoteSessionName: `clanky-native-terminal-${crypto.randomUUID()}`,
      connectionMode: windows ? "dtach" : "direct",
      useTmux: windows,
      allowPersistentSessionCreate: true,
      callbacks: {
        onOutput: (chunk) => output.push(chunk),
        onError: (error) => errors.push(error),
      },
      localUserId: registration.localUserId,
      fetch: releaseAwareFetch,
    });

    try {
      const result = await connection.connect();
      expect(result.runtimeConnectionMode).toBe("direct");
      if (windows) {
        expect(result.notice).toContain("unavailable on Windows");
      }

      await connection.resize(113, 37);
      const probe = buildTerminalResizeProbe({
        marker: "NATIVE_TERMINAL_SIZE",
        os: platformOs,
        cols: 113,
        rows: 37,
      });
      connection.sendInput(probe.input);
      await pollUntil(
        () => output.join(""),
        (value) => value.includes(probe.expectedOutput),
        {
          description: "native Mesh terminal input, output, and resize",
          timeoutMs: 20_000,
        },
      );
      const expectedDirectory = isAbsolute(directory)
        ? directory
        : join(executionRoot, directory);
      const canonicalExpectedDirectory = await realpath(expectedDirectory);
      const pathStyle = platformOs === "windows" ? "windows" : "posix";
      const cwdMarker = "NATIVE_TERMINAL_CWD";
      const cwdPrefix = `${cwdMarker}:`;
      connection.sendInput(buildTerminalCwdProbe({
        marker: cwdMarker,
        os: platformOs,
      }));
      await pollUntil(
        () => output.join(""),
        (value) => {
          const start = value.lastIndexOf(cwdPrefix);
          const end = value.indexOf(":DONE", start + cwdPrefix.length);
          if (start < 0 || end < 0) {
            return false;
          }
          return executionPathsEqual(
            value.slice(start + cwdPrefix.length, end),
            canonicalExpectedDirectory,
            pathStyle,
          );
        },
        {
          description: "native Mesh terminal working directory",
          timeoutMs: 20_000,
        },
      );
      expect(errors).toEqual([]);
    } finally {
      await connection.dispose();
    }
    if (!capturedRelease) {
      throw new Error("The native Mesh terminal did not issue its release request");
    }
    await expectTerminalSessionReleased(capturedRelease);
  });
}

async function expectTerminalSessionReleased(
  release: CapturedTerminalRelease,
): Promise<void> {
  const terminalUrl = new URL(release.url);
  terminalUrl.pathname = terminalUrl.pathname.replace(/\/session$/, "");
  const authorizationResponse = await fetch(terminalUrl, {
    headers: {
      "x-clanky-mesh-session-id": release.request.sessionId,
      "x-clanky-mesh-session-token": release.request.sessionToken,
    },
    ...(release.tls ? { tls: release.tls } : {}),
  });
  expect(authorizationResponse.status).toBe(401);
  expect(await authorizationResponse.json()).toMatchObject({
    error: "mesh_terminal_session_invalid",
  });

  const repeatedRequest: MeshTerminalSessionCloseRequest = {
    ...release.request,
    requestId: crypto.randomUUID(),
  };
  const repeatedRelease = await fetch(release.url, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-clanky-mesh-session-id": repeatedRequest.sessionId,
      "x-clanky-mesh-request-id": repeatedRequest.requestId,
    },
    body: JSON.stringify(repeatedRequest),
    ...(release.tls ? { tls: release.tls } : {}),
  });
  expect(repeatedRelease.status).toBe(200);
  expect(await repeatedRelease.json()).toEqual({ success: true });
}

async function expectTunnelEcho(
  tunnel: TcpTunnel,
  message: string,
): Promise<void> {
  const echoed = new Promise<string>((resolve, reject) => {
    const expected = Buffer.from(message);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Timed out waiting for the native Mesh TCP echo"));
    }, 10_000);
    tunnel.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    tunnel.on("data", (data) => {
      if (settled) {
        return;
      }
      received = Buffer.concat([received, Buffer.from(data)]);
      if (received.length < expected.length) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(received.toString("utf8"));
    });
  });
  tunnel.write(message);
  expect(await echoed).toBe(message);
}

async function expectPreviewEcho(
  localPort: number,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const expected = Buffer.from(message);
    let received = Buffer.alloc(0);
    let settled = false;
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: localPort,
    });
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for the native Mesh preview echo"));
    }, 10_000);
    socket.once("connect", () => socket.write(message));
    socket.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (data) => {
      if (settled) {
        return;
      }
      received = Buffer.concat([received, Buffer.from(data)]);
      if (received.length < expected.length) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        expect(received.toString("utf8")).toBe(message);
        socket.end();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

async function exerciseMeshTunnels(
  registration: MeshWorkerRegistration,
  binding: ExecutionHostBinding,
): Promise<void> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
    },
  });
  try {
    await runWithCurrentUser({
      id: registration.localUserId,
      username: "native-worker-owner",
      role: "owner",
      isOwner: true,
      isAdmin: true,
    }, async () => {
      const tunnel = await openTcpTunnel({
        binding,
        remoteHost: "127.0.0.1",
        remotePort: server.port,
      });
      const tunnelClosed = new Promise<void>((resolve) => {
        tunnel.once("close", resolve);
      });
      try {
        await expectTunnelEcho(tunnel, "native-mesh-tunnel");
      } finally {
        tunnel.destroy();
        await tunnelClosed;
      }

      const preview = await openPreviewTcpForward(binding, server.port);
      try {
        await expectPreviewEcho(preview.localPort, "native-mesh-preview");
      } finally {
        await preview.close();
      }
    });
  } finally {
    server.stop(true);
  }
}

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

      const excludePathResult = await executor.exec(
        "git",
        ["-C", repoDirectory, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        { cwd: repoDirectory },
      );
      expect(excludePathResult.success).toBe(true);
      const excludeContent = await executor.readFile(
        excludePathResult.stdout.trim(),
      );
      expect(excludeContent).toContain(".clanky-worktrees");
      expect(excludeContent).toContain(".clanky-planning");

      await git.removeWorktree(configuredRepoDirectory, worktreePath, { force: true });
      expect(await executor.directoryExists(worktreePath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("enrolls, reports its runtime, passes health, and reconnects after restart", async () => {
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
    expect(expectedRuntime.platform).not.toBeNull();
    const expectedRunnerOs = process.env["CLANKY_NATIVE_E2E_EXPECTED_OS"];
    if (expectedRunnerOs) {
      const actualRunnerOs: string | undefined = expectedRuntime.platform?.os;
      expect(actualRunnerOs).toBe(expectedRunnerOs);
    }

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
    const workerCapabilities = registration.workerCapabilities ?? {};

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
    expect(workerCapabilities.acpRuntime).toBe(2);
    expect(workerCapabilities).toMatchObject({
      interactiveTerminal: 1,
      tcpTunnel: 1,
      vnc: 1,
    });
    if (expectedRuntime.platform?.os === "windows") {
      expect(workerCapabilities.commandExecution).toBeUndefined();
      expect(workerCapabilities.provisioning).toBeUndefined();
      expect(workerCapabilities.devboxLifecycle).toBeUndefined();
    }

    const providerDiscovery = await meshJsonRequest<{
      providers?: Array<{ providerID: string; available: boolean }>;
    }>(
      controller,
      `/api/execution-hosts/mesh/${
        encodeURIComponent(registration.workerNodeId)
      }/chat-providers`,
      {
        method: "POST",
        body: {},
      },
    );
    expect(providerDiscovery.status).toBe(200);
    expect(providerDiscovery.body.providers).toContainEqual({
      providerID: "copilot",
      available: true,
    });

    const executionHosts = await meshJsonRequest<ExecutionHostDescriptor[]>(
      controller,
      "/api/execution-hosts",
    );
    expect(executionHosts.status).toBe(200);
    const executionHost = executionHosts.body.find(
      (candidate) => candidate.ref.kind === "mesh"
        && candidate.ref.nodeId === registration.workerNodeId,
    );
    expect(executionHost).toBeDefined();
    const executionHostBinding: ExecutionHostBinding = {
      host: executionHost!.ref,
      targetKey: executionHost!.targetKey,
      revision: executionHost!.revision,
    };

    const initialHealth = await pollUntil<
      MeshJsonResponse<MeshHealthResponse>
    >(
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
    const initialLastSeenAt = initialHealth.body.status.workers[0]!.lastSeenAt!;

    const filesPath = `/api/execution-hosts/mesh/${encodeURIComponent(
      registration.workerNodeId,
    )}/files`;
    const createdFile = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          content: "created on native worker\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(createdFile.status).toBe(200);
    expect(createdFile.body.file.path).toBe("native-files/worker.txt");

    const createdPlan = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-files/.clanky-planning/plan.md",
          content: "# Native relative workspace plan\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(createdPlan.status).toBe(200);

    const terminalDirectoryFile = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-terminal/session.txt",
          content: "terminal cwd\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(terminalDirectoryFile.status).toBe(200);

    const previousDataDir = process.env["CLANKY_DATA_DIR"];
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = controller.dataDir;
    await initializeDatabase();
    const meshExecutor = new MeshCommandExecutor({
      workspaceId: "native-relative-workspace",
      directory: "native-files",
      executionNodeId: registration.workerNodeId,
      provider: "copilot",
      localUserId: registration.localUserId,
      pathStyle: executionPathStyleForPlatform(process.platform),
      capabilities: workerCapabilities,
    });
    try {
      const executionDirectory = await meshExecutor.getExecutionDirectory();
      const platformOs = expectedRuntime.platform!.os;
      expect(executionDirectory).toBe(join(worker.dataDir, "native-files"));
      expect(await meshExecutor.fileExists(
        join(executionDirectory, ".clanky-planning", "plan.md"),
      )).toBe(true);
      expect(await meshExecutor.isAgentProviderAvailable("copilot")).toBe(true);

      for (const scenario of [
        { legacyRelease: false, relativeDirectory: false },
        { legacyRelease: true, relativeDirectory: true },
      ]) {
        await exerciseMeshTerminal(
          registration,
          worker.dataDir,
          scenario.relativeDirectory
            ? "native-terminal"
            : join(worker.dataDir, "native-terminal"),
          platformOs,
          { legacyRelease: scenario.legacyRelease },
        );
      }
      const deletedTerminalDirectory = await meshJsonRequest<FileMutationResponse>(
        controller,
        `${filesPath}/delete`,
        {
          method: "POST",
          body: {
            path: "native-terminal",
            kind: "directory",
            startDirectory: null,
          },
        },
      );
      expect(deletedTerminalDirectory.status).toBe(200);
      expect(await Bun.file(
        join(worker.dataDir, "native-terminal", "session.txt"),
      ).exists()).toBe(false);

      await exerciseMeshTunnels(registration, executionHostBinding);

      const git = GitService.withExecutor(meshExecutor);
      for (const args of [
        ["init"],
        ["config", "user.name", "Clanky Mesh E2E"],
        ["config", "user.email", "mesh-e2e@clanky.invalid"],
      ]) {
        const result = await meshExecutor.execGit(
          executionDirectory,
          args,
          { scope: "repository" },
        );
        expect(result.success).toBe(true);
      }
      const gitSshCommand = await meshExecutor.getGitEnvironmentVariable(
        "GIT_SSH_COMMAND",
      );
      expect(
        gitSshCommand === null || typeof gitSshCommand === "string",
      ).toBe(true);
      expect(await git.isGitRepo(executionDirectory)).toBe(true);
      expect(await meshExecutor.writeFile(
        join(executionDirectory, "git-tracked.txt"),
        "initial through Mesh\n",
      )).toBe(true);
      await git.stageAll(executionDirectory);
      await git.commit(
        executionDirectory,
        "test: initialize Mesh repository",
      );
      const currentBranch = await git.getCurrentBranch(executionDirectory);
      expect(currentBranch.length).toBeGreaterThan(0);
      expect(await git.hasUncommittedChanges(executionDirectory)).toBe(false);

      expect(await meshExecutor.writeFile(
        join(executionDirectory, "git-tracked.txt"),
        "changed through Mesh\n",
      )).toBe(true);
      expect(await git.getChangedFiles(executionDirectory)).toEqual([
        "git-tracked.txt",
      ]);

      const worktreePath = await git.getManagedWorktreePath(
        executionDirectory,
        "native-mesh-e2e",
      );
      await git.createWorktree(
        executionDirectory,
        worktreePath,
        "native-mesh-e2e",
        currentBranch,
      );
      expect(
        await git.worktreeExists(executionDirectory, worktreePath),
      ).toBe(true);
      expect(
        (await git.listWorktrees(executionDirectory)).some(
          (worktree) => worktree.branch === "native-mesh-e2e",
        ),
      ).toBe(true);
      await git.removeWorktree(
        executionDirectory,
        worktreePath,
        { force: true },
      );
      expect(await meshExecutor.directoryExists(worktreePath)).toBe(false);
      await exerciseMeshAcpRuntime(registration, executionDirectory);
    } catch (error) {
      const serverLogFile = Bun.file(
        join(worker.dataDir, "logs", "server.log"),
      );
      const serverLog = await serverLogFile.exists()
        ? await serverLogFile.text()
        : "";
      let processOutput = "";
      if (worker.child.exitCode !== null) {
        const [stdout, stderr] = await Promise.all([
          worker.output.stdout,
          worker.output.stderr,
        ]);
        processOutput = [stdout.trim(), stderr.trim()]
          .filter((value) => value.length > 0)
          .join("\n");
      } else {
        processOutput = worker.output.snapshot();
      }
      const diagnostics = [serverLog.trim(), processOutput]
        .filter((value) => value.length > 0)
        .join("\n")
        .slice(-20_000);
      throw new Error(
        `Native worker feature scenario failed (exit ${
          String(worker.child.exitCode)
        }, signal ${String(worker.child.signalCode)})${
          diagnostics ? `:\n${diagnostics}` : "."
        }`,
        { cause: error },
      );
    } finally {
      meshExecutor.close();
      closeDatabase();
      if (previousDataDir === undefined) {
        delete process.env["CLANKY_DATA_DIR"];
      } else {
        process.env["CLANKY_DATA_DIR"] = previousDataDir;
      }
    }

    const listedFiles = await meshJsonRequest<FileListResponse>(
      controller,
      `${filesPath}?path=${encodeURIComponent("native-files")}`,
    );
    expect(listedFiles.status).toBe(200);
    expect(listedFiles.body.directory).toBe("native-files");
    expect(listedFiles.body.entries).toContainEqual({
      name: "worker.txt",
      path: "native-files/worker.txt",
      kind: "file",
    });

    const readFile = await meshJsonRequest<FileReadResponse>(
      controller,
      `${filesPath}/content?path=${encodeURIComponent("native-files/worker.txt")}`,
    );
    expect(readFile.status).toBe(200);
    expect(readFile.body).toMatchObject({
      content: "created on native worker\n",
      file: { path: "native-files/worker.txt" },
    });

    const overwrittenFile = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          content: "updated on native worker\n",
          expectedVersionToken: createdFile.body.file.versionToken,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(overwrittenFile.status).toBe(200);
    expect(await Bun.file(
      join(worker.dataDir, "native-files", "worker.txt"),
    ).text()).toBe("updated on native worker\n");

    const renamedFile = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/rename`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          newName: "renamed.txt",
          expectedVersionToken: overwrittenFile.body.file.versionToken,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(renamedFile.status).toBe(200);
    expect(renamedFile.body.file?.path).toBe("native-files/renamed.txt");

    const downloadResponse = await meshJsonRequest<string>(
      controller,
      `${filesPath}/download?path=${
        encodeURIComponent("native-files/renamed.txt")
      }`,
      {
        responseType: "text",
      },
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body).toBe("updated on native worker\n");

    const uploadedContent = "streamed to native worker\n";
    const upload = await meshJsonRequest<FileUploadResponse>(
      controller,
      `${filesPath}/upload`,
      {
        method: "POST",
        body: {
          directory: "native-files",
          fileName: "renamed.txt",
          size: new TextEncoder().encode(uploadedContent).byteLength,
          overwrite: true,
          startDirectory: null,
        },
      },
    );
    expect(upload.status).toBe(201);

    const uploadChunkResponse = await meshJsonRequest<{ success: boolean }>(
      controller,
      `${filesPath}/upload/chunk?uploadId=${
        encodeURIComponent(upload.body.uploadId)
      }&offset=0`,
      {
        method: "POST",
        rawBody: uploadedContent,
      },
    );
    expect(uploadChunkResponse.status).toBe(200);

    const completedUpload = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/upload/complete`,
      {
        method: "POST",
        body: {
          uploadId: upload.body.uploadId,
          startDirectory: null,
        },
      },
    );
    expect(completedUpload.status).toBe(200);
    expect(completedUpload.body.file?.path).toBe("native-files/renamed.txt");

    const uploadedFile = await meshJsonRequest<FileReadResponse>(
      controller,
      `${filesPath}/content?path=${
        encodeURIComponent("native-files/renamed.txt")
      }`,
    );
    expect(uploadedFile.status).toBe(200);
    expect(uploadedFile.body.content).toBe(uploadedContent);

    const deletedDirectory = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/delete`,
      {
        method: "POST",
        body: {
          path: "native-files",
          kind: "directory",
          startDirectory: null,
        },
      },
    );
    expect(deletedDirectory.status).toBe(200);
    expect(deletedDirectory.body.deletedPath).toBe("native-files");
    expect(await Bun.file(
      join(worker.dataDir, "native-files", "renamed.txt"),
    ).exists()).toBe(false);

    const escapedWrite = await meshJsonRequest<{ error: string }>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "../native-worker-escape.txt",
          content: "must not escape\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(escapedWrite.status).toBe(400);
    expect(escapedWrite.body.error).toBe("invalid_server_path");

    await restartMeshNode(worker, 20_000);
    expect(worker.generation).toBe(2);

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
    const registrationAfterRestart = healthAfterRestart.body.status.workers[0]!;
    expect(registrationAfterRestart.createdAt).toBe(registration.createdAt);
    expectRuntimeSnapshot(registrationAfterRestart, expectedRuntime);
  }, 120_000);
});
