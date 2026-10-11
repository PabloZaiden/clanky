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
import { installExternalNativeCopilotProvider } from "./support/provider";
import { createGitFixture } from "./support/git";
import { startMeshDevboxFixture } from "./support/mesh-devbox";

interface ControllerStatus {
  workers: Array<{ workerNodeId: string }>;
}

interface ExecutionHost {
  ref: { kind: string; nodeId?: string };
}

interface Workspace {
  id: string;
}

interface Chat {
  config: { id: string };
  state: { status: string; session?: { id: string } };
}

interface PlanningTask {
  config: { id: string };
  state: {
    status: string;
    session?: { id: string };
    planMode?: { isPlanReady: boolean };
  };
}

interface ProvisioningSnapshot {
  job: {
    config: { id: string };
    state: { status: string; workspaceId?: string; targetDirectory?: string; error?: unknown };
  };
}

interface ChatSnapshot {
  transcript: { messages: Array<{ role: string; content: string }> };
}

async function runAutomaticWorkspaceJob(
  controller: ManagedMeshNode,
  request: Record<string, unknown>,
): Promise<ProvisioningSnapshot> {
  const started = await meshJsonRequest<ProvisioningSnapshot>(controller, "/api/provisioning-jobs", {
    method: "POST", body: request,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const result = await pollUntil(
    async () => (await meshJsonRequest<ProvisioningSnapshot>(controller, `/api/provisioning-jobs/${started.body.job.config.id}`)).body,
    (value) => ["completed", "failed"].includes(value.job.state.status), {
      description: `automatic workspace ${String(request["mode"])} job`, timeoutMs: 10_000,
      formatLastObserved: (value) => JSON.stringify(value),
    },
  );
  expect(result.job.state.status, JSON.stringify(result)).toBe("completed");
  return result;
}

test("users can maintain and retire an automatic workspace while planning and chatting in another", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-independent-"));
  const nodes: ManagedMeshNode[] = [];
  let devbox: Awaited<ReturnType<typeof startMeshDevboxFixture>> | undefined;
  let failure: unknown;
  try {
    const bin = join(fixtureDirectory, "bin");
    await installExternalNativeCopilotProvider(bin);
    devbox = await startMeshDevboxFixture(bin);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({ role: "controller", command, instanceName: "independent-controller" });
    nodes.push(controller);
    const home = join(fixtureDirectory, "worker-home");
    await mkdir(home);
    const worker = await startMeshNode({
      role: "worker", command, instanceName: "planning-worker",
      environment: { HOME: home, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const workerId = (await meshJsonRequest<ControllerStatus>(controller, "/api/mesh/status")).body.workers[0]!.workerNodeId;
    const hosts = await meshJsonRequest<ExecutionHost[]>(controller, "/api/execution-hosts");
    const host = hosts.body.find((entry) => entry.ref.nodeId === workerId)!;
    const git = await createGitFixture(worker.dataDir);
    const workspace = await meshJsonRequest<Workspace>(controller, "/api/workspaces", {
      method: "POST", body: {
        name: "Concurrent worker work", directory: git.repositoryDirectory, executionHost: host.ref,
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      },
    });
    expect(workspace.status).toBe(201);
    const model = { providerID: "copilot", modelID: "e2e-copilot-model", variant: "" };
    const taskInput = join(fixtureDirectory, "task-input.txt");
    const chatInput = join(fixtureDirectory, "chat-input.txt");
    const task = await meshJsonRequest<PlanningTask>(controller, "/api/tasks", {
      method: "POST", body: {
        name: "Prepare integration plan", workspaceId: workspace.body.id,
        prompt: `Prepare the plan using the integration input [wait-for-file:${taskInput}]`,
        model, baseBranch: git.branch, useWorktree: true, autoAcceptPlan: false,
        attachments: [], maxIterations: 2, maxConsecutiveErrors: 2,
        activityTimeoutSeconds: null, stopPattern: "<promise>COMPLETE</promise>",
        git: { branchPrefix: "e2e/", commitScope: "" }, clearPlanningFolder: true,
        fullyAutonomous: false, draft: false, cheapModel: { mode: "same-as-task" },
      },
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    const chat = await meshJsonRequest<Chat>(controller, "/api/chats", {
      method: "POST", body: {
        name: "Integration discussion", workspaceId: workspace.body.id, model,
        baseBranch: git.branch, useWorktree: false,
      },
    });
    expect(chat.status).toBe(201);
    const startedChat = await meshJsonRequest(controller, `/api/chats/${chat.body.config.id}/messages`, {
      method: "POST", body: { message: `Read the integration input [wait-for-file:${chatInput}]` },
    });
    expect(startedChat.status).toBe(200);
    await pollUntil(async () => ({
      task: (await meshJsonRequest<PlanningTask>(controller, `/api/tasks/${task.body.config.id}`)).body,
      chat: (await meshJsonRequest<Chat>(controller, `/api/chats/${chat.body.config.id}`)).body,
    }), (value) => !!value.task.state.session && value.task.state.status === "planning"
      && !!value.chat.state.session && value.chat.state.status === "streaming", {
      description: "independent worker task and chat to enter active native sessions",
      timeoutMs: 10_000, formatLastObserved: (value) => JSON.stringify(value),
    });
    const automaticRequest = {
      name: "Automatic maintenance workspace", executionHost: host.ref,
      transport: "worker", workerEnrollmentRoute: "direct",
      workerHostAddress: "127.0.0.1", workerHostAddressManual: true,
      repoUrl: git.remoteDirectory, basePath: join(fixtureDirectory, "automatic"),
      devcontainerSubpath: null, devboxTemplate: null, githubUser: null,
      provider: "copilot", adapter: "copilot", credentialToken: null,
      mode: "provision", targetDirectory: null, workspaceId: null,
    };
    const automatic = await runAutomaticWorkspaceJob(controller, automaticRequest);
    const automaticWorkspaceId = automatic.job.state.workspaceId!;
    for (const mode of ["restart", "rebuild"]) {
      await runAutomaticWorkspaceJob(controller, {
        ...automaticRequest, mode, workspaceId: automaticWorkspaceId,
        targetDirectory: automatic.job.state.targetDirectory,
      });
      const checkout = await meshJsonRequest<{ exitCode: number; stdout: string }>(controller, `/api/workspaces/${automaticWorkspaceId}/exec`, {
        method: "POST", body: { command: "git", args: ["show", "HEAD:README.md"], timeoutMs: 5_000 },
      });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
      expect(checkout.body.exitCode).toBe(0);
      expect(checkout.body.stdout).toBe(await Bun.file(join(git.repositoryDirectory, "README.md")).text());
    }
    const automaticChat = await meshJsonRequest<Chat>(controller, "/api/chats", {
      method: "POST", body: {
        name: "Automatic workspace discussion", workspaceId: automaticWorkspaceId,
        model, baseBranch: git.branch, useWorktree: false,
      },
    });
    expect(automaticChat.status).toBe(201);
    const maintenanceMessage = "Review the maintained workspace.";
    expect((await meshJsonRequest(controller, `/api/chats/${automaticChat.body.config.id}/messages`, {
      method: "POST", body: { message: maintenanceMessage },
    })).status).toBe(200);
    await pollUntil(
      async () => (await meshJsonRequest<Chat>(controller, `/api/chats/${automaticChat.body.config.id}`)).body,
      (value) => value.state.status === "idle", {
        description: "maintained workspace conversation to finish", timeoutMs: 10_000,
        formatLastObserved: (value) => JSON.stringify(value),
      },
    );
    const maintenanceTranscript = await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${automaticChat.body.config.id}/snapshot?full=1`);
    expect(maintenanceTranscript.body.transcript.messages.some((message) =>
      message.role === "assistant" && message.content.includes(maintenanceMessage))).toBe(true);
    expect((await meshJsonRequest(controller, `/api/chats/${automaticChat.body.config.id}`, { method: "DELETE" })).status).toBe(200);
    const deleted = await meshJsonRequest(controller, `/api/workspaces/${automaticWorkspaceId}`, { method: "DELETE" });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const denied = await meshJsonRequest(controller, `/api/workspaces/${automaticWorkspaceId}/exec`, {
      method: "POST", body: { command: "git", args: ["--version"], timeoutMs: 5_000 },
    });
    expect(denied.status).toBe(404);
    await Bun.write(taskInput, "# Integration plan\nUse the supplied integration input.");
    await Bun.write(chatInput, "Integration discussion is ready.");
    await pollUntil(async () => ({
      task: (await meshJsonRequest<PlanningTask>(controller, `/api/tasks/${task.body.config.id}`)).body,
      chat: (await meshJsonRequest<Chat>(controller, `/api/chats/${chat.body.config.id}`)).body,
    }), (value) => value.task.state.planMode?.isPlanReady === true && value.chat.state.status === "idle", {
      description: "planning and chat to finish on the original worker after independent worker maintenance",
      timeoutMs: 10_000, formatLastObserved: (value) => JSON.stringify(value),
    });
    const plan = await meshJsonRequest<{ content: string; exists: boolean }>(controller, `/api/tasks/${task.body.config.id}/plan`);
    expect(plan.body.exists).toBe(true);
    expect(plan.body.content).toContain("Use the supplied integration input.");
    const transcript = await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${chat.body.config.id}/snapshot?full=1`);
    expect(transcript.body.transcript.messages.some((message) => message.content.includes("Integration discussion is ready."))).toBe(true);
    expect((await meshJsonRequest(controller, `/api/tasks/${task.body.config.id}/plan/discard`, { method: "POST" })).status).toBe(200);
    expect((await meshJsonRequest(controller, `/api/chats/${chat.body.config.id}`, { method: "DELETE" })).status).toBe(200);
  } catch (error) {
    failure = new Error(`Independent worker journey failed: ${String(error)}\n${nodes.map(meshNodeDiagnostics).join("\n")}\n${devbox?.diagnostics() ?? ""}`, { cause: error });
    throw failure;
  } finally {
    const cleanup = await Promise.allSettled([
      ...nodes.toReversed().map(stopMeshNode), devbox?.stop(),
    ]);
    const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, "Independent worker teardown failed");
  }
});
