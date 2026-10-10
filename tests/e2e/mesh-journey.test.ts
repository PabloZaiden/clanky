import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  enrollRelayMeshWorker,
  meshJsonRequest,
  meshNodeDiagnostics,
  restartMeshNode,
  startMeshRelay,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { installExternalAcpProvider } from "./support/provider";

interface MeshRegistration {
  workerNodeId: string;
  workerInstanceName: string;
  workerEndpoint: string;
  workerTransport: string;
  grantStatus: string;
  lastSeenAt: string | null;
  route: {
    kind: string;
    tlsTrust: string;
  };
}

interface ControllerStatus {
  workers: MeshRegistration[];
}

interface WorkerStatus {
  node: {
    nodeId: string;
  };
  controllerCount: number;
  execution: {
    acceptRemoteExecution: boolean;
  };
}

interface ControllerRelayStatus {
  controllerFingerprint: string;
  primaryName: string | null;
  relays: Array<{
    connected: boolean;
    isPrimary: boolean;
    name: string;
    relayUrl: string;
  }>;
}

interface ExecutionHost {
  ref: {
    kind: string;
    nodeId?: string;
  };
}

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Workspace {
  id: string;
}

interface Model {
  providerID: string;
  modelID: string;
  connected: boolean;
}

interface Chat {
  config: {
    id: string;
  };
  state: {
    status: string;
  };
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      role: string;
      content: string;
    }>;
  };
}

async function executeOnWorker(
  controller: ManagedMeshNode,
  workerNodeId: string,
  input: {
    command: string;
    args: string[];
    cwd: string;
  },
): Promise<ExecutionResult> {
  const response = await meshJsonRequest<ExecutionResult>(
    controller,
    `/api/execution-hosts/mesh/${encodeURIComponent(workerNodeId)}/exec`,
    {
      method: "POST",
      body: {
        ...input,
        timeoutMs: 5_000,
      },
    },
  );
  if (response.status !== 200 || !response.body.success) {
    throw new Error(
      `Mesh execution failed: HTTP ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function waitForWorkerExecution(options: {
  controller: ManagedMeshNode;
  description: string;
  input: {
    command: string;
    args: string[];
    cwd: string;
  };
  workerNodeId: string;
}): Promise<ExecutionResult> {
  const response = await pollUntil(
    async () => await meshJsonRequest<ExecutionResult>(
      options.controller,
      `/api/execution-hosts/mesh/${encodeURIComponent(options.workerNodeId)}/exec`,
      {
        method: "POST",
        body: {
          ...options.input,
          timeoutMs: 5_000,
        },
      },
    ),
    (candidate) => candidate.status === 200 && candidate.body.success,
    {
      description: options.description,
      timeoutMs: 10_000,
      formatLastObserved: (candidate) => JSON.stringify(candidate),
    },
  );
  return response.body;
}

async function waitForIdleChat(
  controller: ManagedMeshNode,
  chatId: string,
): Promise<Chat> {
  const observation = await pollUntil(
    async () => await meshJsonRequest<Chat>(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}`,
    ),
    (response) => response.status === 200
      && (response.body.state.status === "idle" || response.body.state.status === "failed"),
    {
      description: `Mesh chat ${chatId} to settle`,
      timeoutMs: 10_000,
      formatLastObserved: (response) => JSON.stringify(response),
    },
  );
  return observation.body;
}

test("compiled controller and worker execute an ACP chat across Mesh and reconnect", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-e2e-"));
  const providerBinDirectory = join(fixtureDirectory, "bin");
  const homeDirectory = join(fixtureDirectory, "home");
  const nodes: ManagedMeshNode[] = [];
  try {
    await Promise.all([
      installExternalAcpProvider(providerBinDirectory),
      mkdir(homeDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      instanceName: "e2e-controller",
      environment: {
        HOME: homeDirectory,
        CLANKY_LOG_LEVEL: process.platform === "win32" ? "error" : undefined,
      },
    });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "e2e-worker",
      environment: {
        HOME: homeDirectory,
        PATH: `${providerBinDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
        CLANKY_LOG_LEVEL: process.platform === "win32" ? "error" : undefined,
      },
    });
    nodes.push(worker);

    await enrollMeshWorker(controller, worker);

    const registered = await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(
        controller,
        "/api/mesh/status",
      ),
      (response) => response.status === 200 && response.body.workers.length === 1,
      {
        description: "worker registration on the compiled controller",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const registration = registered.body.workers[0]!;
    expect(registration).toEqual(expect.objectContaining({
      workerInstanceName: "e2e-worker",
      workerEndpoint: worker.baseUrl,
      workerTransport: "https",
      grantStatus: "active",
      route: expect.objectContaining({
        kind: "direct",
        tlsTrust: "pinned",
      }),
    }));

    const workerStatus = await meshJsonRequest<WorkerStatus>(
      worker,
      "/api/mesh/status",
    );
    expect(workerStatus.status).toBe(200);
    expect(workerStatus.body).toEqual(expect.objectContaining({
      node: expect.objectContaining({ nodeId: registration.workerNodeId }),
      controllerCount: 1,
      execution: expect.objectContaining({
        acceptRemoteExecution: true,
      }),
    }));

    const workspaceDirectory = join(worker.dataDir, "workspace");
    const createDirectory = process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[System.IO.Directory]::CreateDirectory('${workspaceDirectory.replaceAll("'", "''")}') | Out-Null`,
          ],
        }
      : {
          command: "mkdir",
          args: ["-p", workspaceDirectory],
        };
    await executeOnWorker(controller, registration.workerNodeId, {
      ...createDirectory,
      cwd: worker.dataDir,
    });

    const hosts = await meshJsonRequest<ExecutionHost[]>(
      controller,
      "/api/execution-hosts",
    );
    expect(hosts.status).toBe(200);
    const workerHost = hosts.body.find(
      (host) => host.ref.kind === "mesh" && host.ref.nodeId === registration.workerNodeId,
    );
    expect(workerHost).toBeDefined();

    const createdWorkspace = await meshJsonRequest<Workspace>(
      controller,
      "/api/workspaces",
      {
        method: "POST",
        body: {
          name: "Mesh E2E workspace",
          directory: workspaceDirectory,
          executionHost: workerHost!.ref,
          workspaceType: "directory",
          allowWorktrees: false,
          serverSettings: {
            agent: {
              adapter: "acp",
              provider: "copilot",
            },
          },
        },
      },
    );
    expect(createdWorkspace.status).toBe(201);

    const models = await meshJsonRequest<Model[]>(
      controller,
      `/api/models?workspaceId=${encodeURIComponent(createdWorkspace.body.id)}`,
    );
    if (models.status !== 200) {
      throw new Error(
        `Mesh model discovery failed: HTTP ${String(models.status)} ${JSON.stringify(models.body)}`,
      );
    }
    const discoveredModel = models.body.find(
      (model) => model.providerID === "copilot" && model.connected,
    );
    expect(discoveredModel?.modelID).toBe("mock-model");
    const model = {
      providerID: discoveredModel!.providerID,
      modelID: discoveredModel!.modelID,
      variant: "",
    };

    const createdChat = await meshJsonRequest<Chat>(
      controller,
      "/api/chats",
      {
        method: "POST",
        body: {
          name: "Mesh E2E chat",
          workspaceId: createdWorkspace.body.id,
          model,
          useWorktree: false,
          autoApprovePermissions: true,
        },
      },
    );
    expect(createdChat.status).toBe(201);
    const chatId = createdChat.body.config.id;

    const firstMessage = await meshJsonRequest(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: "POST",
        body: {
          message: "[provider-write] Exercise ACP on the Mesh worker",
          attachments: [],
        },
      },
    );
    expect(firstMessage.status).toBe(200);
    expect((await waitForIdleChat(controller, chatId)).state.status).toBe("idle");

    const readFile = process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Content -Raw -LiteralPath 'e2e-provider-change.txt'",
          ],
        }
      : {
          command: "cat",
          args: ["e2e-provider-change.txt"],
        };
    expect(
      (await executeOnWorker(controller, registration.workerNodeId, {
        ...readFile,
        cwd: workspaceDirectory,
      })).stdout.trim(),
    ).toBe("created by the external ACP provider");

    const initialHealth = await meshJsonRequest<{
      success: boolean;
      status: ControllerStatus;
    }>(
      controller,
      "/api/mesh/health",
      { method: "POST" },
    );
    expect(initialHealth.status).toBe(200);
    expect(initialHealth.body.success).toBe(true);
    expect(initialHealth.body.status.workers[0]?.lastSeenAt).toBeString();

    await restartMeshNode(worker, 10_000);
    const reconnected = await pollUntil(
      async () => await meshJsonRequest<WorkerStatus>(
        worker,
        "/api/mesh/status",
      ),
      (response) => response.status === 200
        && response.body.node.nodeId === registration.workerNodeId
        && response.body.controllerCount === 1,
      {
        description: "worker identity and controller grant after restart",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(reconnected.body.execution.acceptRemoteExecution).toBe(true);

    const secondMessage = await meshJsonRequest(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}/messages`,
      {
        method: "POST",
        body: {
          message: "Continue after the worker restart",
          attachments: [],
        },
      },
    );
    expect(secondMessage.status).toBe(200);
    expect((await waitForIdleChat(controller, chatId)).state.status).toBe("idle");

    const snapshot = await meshJsonRequest<ChatSnapshot>(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}/snapshot?full=1`,
    );
    expect(snapshot.status).toBe(200);
    expect(
      snapshot.body.transcript.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(
      snapshot.body.transcript.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(2);
  } catch (error) {
    for (const node of nodes) {
      const diagnostics = meshNodeDiagnostics(node);
      if (diagnostics.length > 0) {
        console.error(`${node.role} diagnostics:\n${diagnostics}`);
      }
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const node of nodes.reverse()) {
      try {
        await stopMeshNode(node);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(fixtureDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Failed to clean up Mesh E2E fixtures");
    }
  }
}, 120_000);

test("compiled relays route worker execution, reconnect, and enforce revocation", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-relay-e2e-"));
  const homeDirectory = join(fixtureDirectory, "home");
  const nodes: ManagedMeshNode[] = [];
  try {
    await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      instanceName: "e2e-relay-controller",
      environment: { HOME: homeDirectory },
    });
    nodes.push(controller);

    const bootstrap = await meshJsonRequest<ControllerRelayStatus>(
      controller,
      "/api/mesh/relay",
    );
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.controllerFingerprint).toStartWith("sha256:");

    const eastRelay = await startMeshRelay({
      command,
      controllerFingerprint: bootstrap.body.controllerFingerprint,
      environment: { HOME: homeDirectory },
    });
    nodes.push(eastRelay);
    const westRelay = await startMeshRelay({
      command,
      controllerFingerprint: bootstrap.body.controllerFingerprint,
      environment: { HOME: homeDirectory },
    });
    nodes.push(westRelay);

    for (const [name, relay] of [
      ["east", eastRelay],
      ["west", westRelay],
    ] as const) {
      const paired = await meshJsonRequest<ControllerRelayStatus>(
        controller,
        "/api/mesh/relay",
        {
          method: "POST",
          body: { name, relayUrl: relay.baseUrl },
        },
      );
      expect(paired.status).toBe(201);
    }
    const selectedPrimary = await meshJsonRequest<ControllerRelayStatus>(
      controller,
      "/api/mesh/relay/primary",
      { method: "POST", body: { name: "west" } },
    );
    expect(selectedPrimary.status).toBe(200);
    expect(selectedPrimary.body.primaryName).toBe("west");

    await pollUntil(
      async () => await meshJsonRequest<ControllerRelayStatus>(
        controller,
        "/api/mesh/relay",
      ),
      (response) => response.status === 200
        && response.body.relays.length === 2
        && response.body.relays.every((relay) => relay.connected)
        && response.body.relays.find((relay) => relay.name === "west")?.isPrimary === true,
      {
        description: "both controller relays to connect with west primary",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );

    const worker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "e2e-relay-worker",
      environment: { HOME: homeDirectory },
      relayOnly: true,
    });
    nodes.push(worker);
    await enrollRelayMeshWorker(controller, westRelay, worker);

    const registered = await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(
        controller,
        "/api/mesh/status",
      ),
      (response) => response.status === 200
        && response.body.workers.length === 1
        && response.body.workers[0]?.grantStatus === "active"
        && response.body.workers[0]?.route.kind === "relay",
      {
        description: "relay-only worker registration",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const registration = registered.body.workers[0]!;
    expect(registration.workerEndpoint).toBe(westRelay.baseUrl);
    expect(registration.route.kind).toBe("relay");

    const probe = process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output 'CLANKY_RELAY_E2E'",
          ],
        }
      : {
          command: "printf",
          args: ["CLANKY_RELAY_E2E\\n"],
        };
    expect(
      (await executeOnWorker(controller, registration.workerNodeId, {
        ...probe,
        cwd: worker.dataDir,
      })).stdout.trim(),
    ).toBe("CLANKY_RELAY_E2E");

    await restartMeshNode(westRelay, 10_000);
    await pollUntil(
      async () => ({
        relays: await meshJsonRequest<ControllerRelayStatus>(
          controller,
          "/api/mesh/relay",
        ),
        workers: await meshJsonRequest<ControllerStatus>(
          controller,
          "/api/mesh/status",
        ),
      }),
      ({ relays, workers }) => relays.status === 200
        && relays.body.relays.find((relay) => relay.name === "west")?.connected === true
        && workers.status === 200
        && workers.body.workers[0]?.grantStatus === "active",
      {
        description: "relay and worker reconnection after relay restart",
        timeoutMs: 10_000,
        formatLastObserved: (value) => JSON.stringify(value),
      },
    );
    expect(
      (await waitForWorkerExecution({
        controller,
        workerNodeId: registration.workerNodeId,
        input: { ...probe, cwd: worker.dataDir },
        description: "worker execution after relay restart",
      })).stdout.trim(),
    ).toBe("CLANKY_RELAY_E2E");

    await restartMeshNode(controller, 10_000);
    await pollUntil(
      async () => ({
        relays: await meshJsonRequest<ControllerRelayStatus>(
          controller,
          "/api/mesh/relay",
        ),
        workers: await meshJsonRequest<ControllerStatus>(
          controller,
          "/api/mesh/status",
        ),
      }),
      ({ relays, workers }) => relays.status === 200
        && relays.body.relays.every((relay) => relay.connected)
        && workers.status === 200
        && workers.body.workers[0]?.grantStatus === "active",
      {
        description: "relay topology recovery after controller restart",
        timeoutMs: 10_000,
        formatLastObserved: (value) => JSON.stringify(value),
      },
    );
    expect(
      (await waitForWorkerExecution({
        controller,
        workerNodeId: registration.workerNodeId,
        input: { ...probe, cwd: worker.dataDir },
        description: "worker execution after controller restart",
      })).stdout.trim(),
    ).toBe("CLANKY_RELAY_E2E");

    const revoked = await meshJsonRequest<{ success: boolean }>(
      controller,
      "/api/mesh/workers/revoke",
      {
        method: "POST",
        body: { workerNodeId: registration.workerNodeId },
      },
    );
    expect(revoked.status).toBe(200);
    await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(
        controller,
        "/api/mesh/status",
      ),
      (response) => response.status === 200
        && response.body.workers[0]?.grantStatus === "revoked",
      {
        description: "relay worker revocation",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const deniedExecution = await meshJsonRequest<ExecutionResult>(
      controller,
      `/api/execution-hosts/mesh/${encodeURIComponent(registration.workerNodeId)}/exec`,
      {
        method: "POST",
        body: {
          ...probe,
          cwd: worker.dataDir,
          timeoutMs: 5_000,
        },
      },
    );
    expect(
      deniedExecution.status !== 200 || deniedExecution.body.success === false,
    ).toBe(true);

    const removed = await meshJsonRequest<{ success: boolean }>(
      controller,
      `/api/mesh/workers/${encodeURIComponent(registration.workerNodeId)}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    const finalStatus = await meshJsonRequest<ControllerStatus>(
      controller,
      "/api/mesh/status",
    );
    expect(finalStatus.body.workers).toEqual([]);

    for (const name of ["east", "west"]) {
      const unpaired = await meshJsonRequest<ControllerRelayStatus>(
        controller,
        `/api/mesh/relay/${name}`,
        { method: "DELETE" },
      );
      expect(unpaired.status).toBe(200);
    }
  } catch (error) {
    for (const node of nodes) {
      const diagnostics = meshNodeDiagnostics(node);
      if (diagnostics.length > 0) {
        console.error(`${node.role} diagnostics:\n${diagnostics}`);
      }
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const node of nodes.reverse()) {
      try {
        await stopMeshNode(node);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(fixtureDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Failed to clean up relay Mesh E2E fixtures");
    }
  }
}, 120_000);
