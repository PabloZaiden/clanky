import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createGitFixture, gitStatus, readGitBranchFile } from "./support/git";
import { runProductionHttpSmoke } from "./support/http-smoke";
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
import { currentEnvironment, requireCommand } from "./support/process";
import { installExternalAcpProvider, installExternalGitHubProvider } from "./support/provider";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";

interface ExecutionHost {
  ref: { kind: string; nodeId?: string };
}

interface Chat {
  config: { id: string };
  state: {
    status: string;
    worktree?: { workingBranch: string };
    error?: { message: string };
  };
}

test("users enroll a worker, iterate on a plan and implement it in one chat", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-e2e-"));
  const bin = join(fixtureDirectory, "bin");
  const controllerHome = join(fixtureDirectory, "controller-home");
  const workerHome = join(fixtureDirectory, "worker-home");
  const nodes: ManagedMeshNode[] = [];
  let failure: unknown;
  try {
    await Promise.all([
      installExternalAcpProvider(bin),
      installExternalGitHubProvider(bin),
      mkdir(controllerHome, { mode: 0o700 }),
      mkdir(workerHome, { mode: 0o700 }),
    ]);
    const git = await createGitFixture(fixtureDirectory);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      environment: { HOME: controllerHome, BASH_ENV: undefined, ENV: undefined },
    });
    nodes.push(controller);
    await runProductionHttpSmoke({
      baseUrl: controller.baseUrl,
      ensureProcessRunning() {
        if (controller.child.exitCode !== null) throw new Error("Compiled Clanky exited during HTTP smoke");
      },
    });
    const discovery = await requireCommand([...command, "api"], {
      cwd: fixtureDirectory,
      env: currentEnvironment({
        HOME: controllerHome,
        CLANKY_API_KEY: undefined,
        CLANKY_BASE_URL: controller.baseUrl,
      }),
    });
    expect(discovery.stdout).toContain("chats");
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
    const execution = await meshJsonRequest<{
      success: boolean; exitCode: number; stdout: string; stderr: string;
    }>(controller, `/api/execution-hosts/mesh/${encodeURIComponent(host.ref.nodeId!)}/exec`, {
      method: "POST",
      body: {
        command: "git",
        args: ["branch", "--show-current"],
        cwd: git.repositoryDirectory,
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      },
    });
    expect(execution.status, JSON.stringify(execution.body)).toBe(200);
    expect(execution.body.success, JSON.stringify(execution.body)).toBe(true);
    expect(execution.body.exitCode).toBe(0);
    const baseBranch = execution.body.stdout.trim();
    expect(baseBranch).toBe(git.branch);

    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      method: "POST",
      body: {
        name: "Everyday project",
        directory: git.repositoryDirectory,
        executionHost: host.ref,
        allowClankyContext: false,
        serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      },
    });
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(201);
    const models = await meshJsonRequest<Array<{
      providerID: string; modelID: string; connected: boolean;
    }>>(controller, `/api/models?workspaceId=${workspace.body.id}`);
    expect(models.status).toBe(200);
    const connected = models.body.find((entry) => entry.connected && entry.providerID === "copilot");
    if (!connected) throw new Error("Deterministic ACP model unavailable");
    const chat = await meshJsonRequest<Chat>(controller, "/api/chats", {
      method: "POST",
      body: {
        name: "Implement a project change",
        workspaceId: workspace.body.id,
        model: { providerID: connected.providerID, modelID: connected.modelID, variant: "" },
        baseBranch, useWorktree: true, startWithPlan: true,
      },
    });
    expect(chat.status, JSON.stringify(chat.body)).toBe(201);
    const chatPath = `/api/chats/${encodeURIComponent(chat.body.config.id)}`;
    const prepared = await pollUntil(
      async () => await meshJsonRequest<Chat>(controller, chatPath),
      (response) => response.status === 200
        && (!!response.body.state.worktree || response.body.state.status === "failed"),
      {
        description: "chat working directory",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(prepared.body.state.worktree, JSON.stringify(prepared.body.state)).toBeDefined();
    const document = async (name: string) => {
      const response = await meshJsonRequest<{ exists: boolean; content: string }>(
        controller, `${chatPath}/${name}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    };
    const send = async (message: string): Promise<Chat> => {
      const sent = await meshJsonRequest(controller, `${chatPath}/messages`, {
        method: "POST", body: { message },
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const settled = await pollUntil(
        async () => await meshJsonRequest<Chat>(controller, chatPath),
        (response) => response.status === 200
          && ["idle", "failed"].includes(response.body.state.status),
        {
          description: "planning conversation response",
          timeoutMs: 10_000,
          formatLastObserved: (response) => JSON.stringify(response),
        },
      );
      return settled.body;
    };
    expect((await document("plan")).exists).toBe(false);
    const requirements = "[plan-first] Create the requested fixture change.";
    expect((await send(requirements)).state.status).toBe("idle");
    expect((await document("plan")).content).toContain("Create the requested fixture change");
    expect((await document("status-file")).content).toContain("Waiting for implementation");
    const snapshot = await meshJsonRequest<{
      transcript: { messages: Array<{ role: string; content: string }> };
    }>(controller, `${chatPath}/snapshot?full=1`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.transcript.messages.find((message) => message.role === "user")?.content)
      .toBe(requirements);
    expect(snapshot.body.transcript.messages.some(
      (entry) => entry.role === "assistant" && entry.content.trim().length > 0,
    )).toBe(true);
    expect((await send("Why this approach?")).state.status).toBe("idle");
    expect((await send("[revise-plan] Include documentation.")).state.status).toBe("idle");
    expect((await document("plan")).content).toContain("Include documentation");
    const implemented = await send("[provider-write] Implement the revised plan now.");
    expect(implemented.state.status).toBe("idle");
    const changes = await meshJsonRequest<Array<{ path: string; patch?: string }>>(
      controller, `${chatPath}/diff`,
    );
    expect(changes.status, JSON.stringify(changes.body)).toBe(200);
    expect(changes.body.map((file) => file.path).sort())
      .toEqual(["README.md", "e2e-committed-change.txt", "e2e-provider-change.txt"]);
    expect(changes.body.every((file) => file.patch === undefined)).toBe(true);
    const base = changes.headers.get("X-Clanky-Diff-Base");
    if (!base) throw new Error("Chat Diff did not identify its comparison base");
    const selectedFile = await meshJsonRequest<{ patch: string }>(
      controller,
      `${chatPath}/diff/file?${new URLSearchParams({ base, path: "e2e-provider-change.txt" })}`,
    );
    expect(selectedFile.status, JSON.stringify(selectedFile.body)).toBe(200);
    expect(selectedFile.body.patch).toContain("+created by the external ACP provider");
    const repository = await meshJsonRequest<{
      branch: string | null; pullRequestLookup: string;
    }>(controller, `${chatPath}/repository-context`);
    expect(repository.status, JSON.stringify(repository.body)).toBe(200);
    expect(repository.body.branch).toBe(implemented.state.worktree?.workingBranch ?? null);
    if (!repository.body.branch) throw new Error("Chat did not retain its working branch");
    expect(await readGitBranchFile(git, repository.body.branch, "e2e-committed-change.txt"))
      .toBe("committed implementation");
    expect((await document("status-file")).content).toContain("Implementation complete");
    expect(await gitStatus(git)).toBe("");
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
        "Failed to clean up Mesh chat fixtures",
      );
    }
  }
}, 120_000);
