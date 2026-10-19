import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  meshNodeDiagnostics,
  restartMeshNode,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import {
  installExternalNativeCopilotProvider,
  installExternalWorkerUpdateCommand,
} from "./support/provider";
import { createGitFixture, gitStatus } from "./support/git";
import { startMeshDevboxFixture } from "./support/mesh-devbox";

interface ControllerStatus {
  workers: Array<{
    workerNodeId: string;
    workerInstanceName: string | null;
    workerEndpoint: string;
    registrationScope?: "global" | "workspace";
    grantStatus: string;
  }>;
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

interface WorkerUpdateJob {
  config: {
    id: string;
    workerNodeId: string;
    workerName: string;
  };
  state: {
    status: "pending" | "running" | "completed" | "failed" | "interrupted";
    steps: {
      update: { status: string; execution?: string };
      restart: { status: string; execution?: string };
    };
  };
}

interface WorkerUpdateJobReadResponse {
  job?: WorkerUpdateJob;
  logs?: Array<{ text: string }>;
}

interface StartWorkerUpdatesResponse {
  success: boolean;
  totalWorkers: number;
  results: Array<
    | {
        workerNodeId: string;
        workerName: string;
        status: "started";
        jobId: string;
      }
    | {
        workerNodeId: string;
        workerName: string;
        status: "not_started";
        reason: "already_active";
        error: string;
      }
    | {
        workerNodeId: string;
        workerName: string;
        status: "failed";
        error: string;
      }
  >;
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
      description: `automatic workspace ${String(request["mode"])} job`, timeoutMs: 20_000,
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
    const controller = await startMeshNode({
      role: "controller",
      command,
      instanceName: "independent-controller",
    });

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
        method: "POST", body: { command: "git", args: ["show", "HEAD:README.md"], timeoutMs: MESH_OPERATION_TIMEOUT_MS },
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
      method: "POST", body: { command: "git", args: ["--version"], timeoutMs: MESH_OPERATION_TIMEOUT_MS },
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

test("controller updates server and automatic workspace workers and retains per-worker outcomes", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-worker-update-"));
  const binDirectory = join(fixtureDirectory, "bin");
  const updateStateDirectory = join(fixtureDirectory, "update-state");
  const updateReleasePath = join(updateStateDirectory, "release-update");
  const successHome = join(fixtureDirectory, "success-home");
  const failureHome = join(fixtureDirectory, "failure-home");
  const nodes: ManagedMeshNode[] = [];
  let devbox: Awaited<ReturnType<typeof startMeshDevboxFixture>> | undefined;
  let failure: unknown;
  let gitStatusDescription = "not created";
  let lastObservedPublicState = "No worker update state observed.";
  try {
    await Promise.all([
      mkdir(updateStateDirectory, { recursive: true, mode: 0o700 }),
      mkdir(successHome, { recursive: true, mode: 0o700 }),
      mkdir(failureHome, { recursive: true, mode: 0o700 }),
      installExternalNativeCopilotProvider(binDirectory),
      installExternalWorkerUpdateCommand(binDirectory),
    ]);
    devbox = await startMeshDevboxFixture(binDirectory, { updateStateDirectory });

    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      instanceName: "worker-update-controller",
    });
    nodes.push(controller);

    const workerPath = `${binDirectory}${delimiter}${process.env["PATH"] ?? ""}`;
    const successfulWorker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "global-update-success",
      environment: {
        HOME: successHome,
        PATH: workerPath,
        CLANKY_E2E_WORKER_UPDATE_STATE_DIR: updateStateDirectory,
        CLANKY_E2E_WORKER_UPDATE_ID: "global-update-success",
      },
    });
    nodes.push(successfulWorker);
    const failingWorker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "global-update-failure",
      environment: {
        HOME: failureHome,
        PATH: workerPath,
        CLANKY_E2E_WORKER_UPDATE_STATE_DIR: updateStateDirectory,
        CLANKY_E2E_WORKER_UPDATE_ID: "global-update-failure",
        CLANKY_E2E_WORKER_UPDATE_FAIL: "true",
      },
    });
    nodes.push(failingWorker);

    await enrollMeshWorker(controller, successfulWorker);
    await enrollMeshWorker(controller, failingWorker);

    const globalRegistrations = await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(controller, "/api/mesh/status"),
      (response) => response.status === 200
        && response.body.workers.filter(
          (worker) => worker.grantStatus === "active" && worker.registrationScope !== "workspace",
        ).length === 2,
      {
        description: "both global workers to become active",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const successfulRegistration = globalRegistrations.body.workers.find(
      (worker) => worker.workerInstanceName === "global-update-success",
    );
    const failingRegistration = globalRegistrations.body.workers.find(
      (worker) => worker.workerInstanceName === "global-update-failure",
    );
    if (!successfulRegistration || !failingRegistration) {
      throw new Error("The active global worker registrations were not returned.");
    }

    const gitFixture = await createGitFixture(successfulWorker.dataDir);
    gitStatusDescription = await gitStatus(gitFixture) || "clean";
    const hosts = await meshJsonRequest<ExecutionHost[]>(controller, "/api/execution-hosts");
    expect(hosts.status).toBe(200);
    const successfulHost = hosts.body.find(
      (host) => host.ref.kind === "mesh" && host.ref.nodeId === successfulRegistration.workerNodeId,
    );
    if (!successfulHost) {
      throw new Error("The successful global worker execution host is unavailable.");
    }

    const automaticWorkspace = await runAutomaticWorkspaceJob(controller, {
      name: "Automatic update workspace",
      executionHost: successfulHost.ref,
      transport: "worker",
      workerEnrollmentRoute: "direct",
      workerHostAddress: "127.0.0.1",
      workerHostAddressManual: true,
      repoUrl: gitFixture.remoteDirectory,
      basePath: join(fixtureDirectory, "automatic-workspace"),
      devcontainerSubpath: null,
      devboxTemplate: null,
      githubUser: null,
      provider: "copilot",
      adapter: "copilot",
      credentialToken: null,
      mode: "provision",
      targetDirectory: null,
      workspaceId: null,
    });
    const workspaceRegistrations = await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(controller, "/api/mesh/status"),
      (response) => response.status === 200
        && response.body.workers.some(
          (worker) => worker.registrationScope === "workspace" && worker.grantStatus === "active",
        ),
      {
        description: "automatic workspace worker registration",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const automaticWorker = workspaceRegistrations.body.workers.find(
      (worker) => worker.registrationScope === "workspace",
    );
    if (!automaticWorker) {
      throw new Error("The automatic workspace worker registration is unavailable.");
    }
    const expectedWorkerIds = new Set([
      successfulRegistration.workerNodeId,
      failingRegistration.workerNodeId,
      automaticWorker.workerNodeId,
    ]);

    const admission = await meshJsonRequest<StartWorkerUpdatesResponse>(
      controller,
      "/api/worker-update-jobs",
      { method: "POST" },
    );
    expect(admission.status, JSON.stringify(admission.body)).toBe(202);
    expect(admission.body.totalWorkers).toBe(3);
    expect(admission.body.results).toHaveLength(3);
    expect(admission.body.results.every((item) => item.status === "started")).toBe(true);
    const startedJobs = admission.body.results.filter(
      (item): item is Extract<StartWorkerUpdatesResponse["results"][number], { status: "started" }> =>
        item.status === "started",
    );
    expect(new Set(startedJobs.map((item) => item.workerNodeId))).toEqual(expectedWorkerIds);

    await pollUntil(
      async () => (await meshJsonRequest<{ jobs: WorkerUpdateJob[] }>(controller, "/api/worker-update-jobs")).body.jobs,
      (jobs) => jobs.length === 3 && jobs.every((job) => job.state.steps.update.execution === "started"),
      {
        description: "server and automatic workspace updates to start concurrently",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        formatLastObserved: (state) => {
          lastObservedPublicState = JSON.stringify(state);
          return lastObservedPublicState;
        },
      },
    );
    await Bun.write(updateReleasePath, "release");

    const successfulAdmission = startedJobs.find((item) =>
      item.workerNodeId === successfulRegistration.workerNodeId)!;
    await pollUntil(
      async () => (await meshJsonRequest<WorkerUpdateJobReadResponse>(
        controller, `/api/worker-update-jobs/${successfulAdmission.jobId}`,
      )).body.job,
      (job) => job?.state.steps.restart.execution === "started",
      {
        description: "successful worker service restart request",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      },
    );
    await restartMeshNode(successfulWorker);
    await Bun.write(join(updateStateDirectory, "global-update-success", "service-running"), "running");

    const terminalSnapshots = await pollUntil(
      async () => await Promise.all(startedJobs.map((item) =>
        meshJsonRequest<WorkerUpdateJobReadResponse>(
          controller,
          `/api/worker-update-jobs/${encodeURIComponent(item.jobId)}`,
        ),
      )),
      (responses) => responses.every((response) =>
        response.status === 200
        && ["completed", "failed", "interrupted", "not_started", "connection_failed", "unconfirmed"].includes(response.body.job?.state.status ?? ""),
      ),
      {
        description: "server and automatic workspace update jobs to finish",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        formatLastObserved: (responses) => {
          lastObservedPublicState = JSON.stringify(responses);
          return lastObservedPublicState;
        },
      },
    );
    const successfulJob = terminalSnapshots.find(
      (response) => response.body.job?.config.workerNodeId === successfulRegistration.workerNodeId,
    )?.body.job;
    const failedJob = terminalSnapshots.find(
      (response) => response.body.job?.config.workerNodeId === failingRegistration.workerNodeId,
    )?.body.job;
    const automaticJob = terminalSnapshots.find(
      (response) => response.body.job?.config.workerNodeId === automaticWorker.workerNodeId,
    )?.body.job;
    if (!successfulJob || !failedJob) {
      throw new Error("Per-worker update job results were not returned.");
    }
    expect(successfulJob.state.status, JSON.stringify(terminalSnapshots)).toBe("completed");
    expect(successfulJob.state.steps.update.status).toBe("succeeded");
    expect(successfulJob.state.steps.restart.status).toBe("succeeded");
    expect(failedJob.state.status).toBe("failed");
    expect(failedJob.state.steps.update.status).toBe("failed");
    expect(failedJob.state.steps.restart.status).toBe("skipped");
    expect(automaticJob?.state.status, JSON.stringify(terminalSnapshots)).toBe("completed");
    const automaticWorkspaceId = automaticWorkspace.job.state.workspaceId!;
    const checkout = await meshJsonRequest<{ exitCode: number; stdout: string }>(
      controller, `/api/workspaces/${automaticWorkspaceId}/exec`, {
        method: "POST",
        body: { command: "git", args: ["show", "HEAD:README.md"], timeoutMs: MESH_OPERATION_TIMEOUT_MS },
      },
    );
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body.exitCode).toBe(0);
    expect(checkout.body.stdout).toBe(await Bun.file(join(gitFixture.repositoryDirectory, "README.md")).text());
    expect((await meshJsonRequest(controller, `/api/workspaces/${automaticWorkspaceId}`, {
      method: "DELETE",
    })).status).toBe(200);
    await pollUntil(async () => {
      try {
        const response = await fetch(`${automaticWorker.workerEndpoint}/api/health`, {
          tls: { rejectUnauthorized: false },
          signal: AbortSignal.timeout(MESH_OPERATION_TIMEOUT_MS),
        });
        return { reachable: true, status: response.status, error: null };
      } catch (error) {
        return { reachable: false, status: null, error: String(error) };
      }
    }, (state) => !state.reachable, {
      description: "retired automatic workspace worker to stop",
      timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      formatLastObserved: (state) => JSON.stringify(state),
    });

    await restartMeshNode(controller);
    const retainedJobs = await meshJsonRequest<{ jobs: WorkerUpdateJob[] }>(
      controller,
      "/api/worker-update-jobs",
    );
    expect(retainedJobs.status).toBe(200);
    expect(retainedJobs.body.jobs).toHaveLength(3);
    expect(new Set(retainedJobs.body.jobs.map((job) => job.config.workerNodeId)))
      .toEqual(expectedWorkerIds);

    const retainedFailure = await meshJsonRequest<WorkerUpdateJobReadResponse>(
      controller,
      `/api/worker-update-jobs/${encodeURIComponent(failedJob.config.id)}`,
    );
    expect(retainedFailure.status).toBe(200);
    expect(retainedFailure.body.job?.state.steps.restart.status).toBe("skipped");
    expect(retainedFailure.body.logs?.length ?? 0).toBeGreaterThan(0);
  } catch (error) {
    failure = new Error(
      `Worker update journey failed: ${String(error)}\nLast public state: ${lastObservedPublicState}\nGit status: ${gitStatusDescription}\n${nodes.map(meshNodeDiagnostics).join("\n")}\n${devbox?.diagnostics() ?? ""}`,
      { cause: error },
    );
    throw failure;
  } finally {
    let releaseError: unknown;
    try {
      await mkdir(updateStateDirectory, { recursive: true, mode: 0o700 });
      await Bun.write(updateReleasePath, "release");
    } catch (error) {
      releaseError = error;
    }
    const cleanup = await Promise.allSettled([
      ...nodes.toReversed().map(stopMeshNode),
      devbox?.stop(),
    ]);
    const errors = [
      ...(releaseError ? [releaseError] : []),
      ...cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
    ];
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(
        failure ? [failure, ...errors] : errors,
        "Worker update teardown failed",
      );
    }
  }
});
