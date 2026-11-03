import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  meshNodeDiagnostics,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { installExternalAcpProvider } from "./support/provider";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";

interface ExecutionHost {
  ref: { kind: string; nodeId?: string };
}

interface Chat {
  config: { id: string };
  state: { status: string; error?: { message: string } };
}

test("compiled Mesh controller enrolls a worker, runs a command, and chats remotely", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-e2e-"));
  const bin = join(fixtureDirectory, "bin");
  const controllerHome = join(fixtureDirectory, "controller-home");
  const workerHome = join(fixtureDirectory, "worker-home");
  const nodes: ManagedMeshNode[] = [];
  let failure: unknown;
  try {
    await Promise.all([
      installExternalAcpProvider(bin),
      mkdir(controllerHome, { mode: 0o700 }),
      mkdir(workerHome, { mode: 0o700 }),
    ]);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      environment: { HOME: controllerHome, BASH_ENV: undefined, ENV: undefined },
    });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "smoke-worker",
      environment: {
        HOME: workerHome,
        PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
        BASH_ENV: undefined,
        ENV: undefined,
      },
    });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);

    const hosts = await pollUntil(
      async () => await meshJsonRequest<ExecutionHost[]>(controller, "/api/execution-hosts"),
      (response) => response.status === 200
        && response.body.some((host) => host.ref.kind === "mesh"),
      {
        description: "enrolled worker to appear as an execution host",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const host = hosts.body.find((candidate) => candidate.ref.kind === "mesh")!;
    const directory = join(worker.dataDir, "workspace");
    const execution = await meshJsonRequest<{
      success: boolean; exitCode: number; stdout: string; stderr: string;
    }>(controller, `/api/execution-hosts/mesh/${encodeURIComponent(host.ref.nodeId!)}/exec`, {
      method: "POST",
      body: {
        command: "sh",
        args: ["-c", 'mkdir -p "$1" && printf %s mesh-worker > "$1/remote.txt"', "mesh-smoke", directory],
        cwd: worker.dataDir,
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      },
    });
    expect(execution.status, JSON.stringify(execution.body)).toBe(200);
    expect(execution.body.success, JSON.stringify(execution.body)).toBe(true);
    expect(execution.body.exitCode).toBe(0);
    expect(await Bun.file(join(directory, "remote.txt")).text()).toBe("mesh-worker");

    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      method: "POST",
      body: {
        name: "Mesh smoke",
        directory,
        executionHost: host.ref,
        workspaceType: "directory",
        allowWorktrees: false,
        serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      },
    });
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(201);
    const chat = await meshJsonRequest<Chat>(controller, "/api/chats", {
      method: "POST",
      body: {
        name: "Remote chat",
        workspaceId: workspace.body.id,
        model: { providerID: "copilot", modelID: "mock-model", variant: "" },
        useWorktree: false,
      },
    });
    expect(chat.status, JSON.stringify(chat.body)).toBe(201);
    const chatPath = `/api/chats/${encodeURIComponent(chat.body.config.id)}`;
    const message = "Hello from the Mesh controller";
    const sent = await meshJsonRequest(controller, `${chatPath}/messages`, {
      method: "POST",
      body: { message, attachments: [] },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const settled = await pollUntil(
      async () => await meshJsonRequest<Chat>(controller, chatPath),
      (response) => response.status === 200
        && ["idle", "failed"].includes(response.body.state.status),
      {
        description: "remote provider chat to finish",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(settled.body.state.status, JSON.stringify(settled.body.state)).toBe("idle");
    const snapshot = await meshJsonRequest<{
      transcript: { messages: Array<{ role: string; content: string }> };
    }>(controller, `${chatPath}/snapshot?full=1`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.transcript.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: message }),
    );
    expect(snapshot.body.transcript.messages.some(
      (entry) => entry.role === "assistant" && entry.content.trim().length > 0,
    )).toBe(true);
  } catch (error) {
    failure = error;
    for (const node of nodes) console.error(meshNodeDiagnostics(node));
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
      throw new AggregateError(
        failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
        "Failed to clean up Mesh smoke fixtures",
      );
    }
  }
}, 120_000);
