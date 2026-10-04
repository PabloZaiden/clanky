import { expect, test } from "bun:test";
import { mkdir, mkdtemp, chmod, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { availablePort, meshJsonRequest, enrollMeshWorker, restartMeshNode, type ManagedMeshNode } from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";
import type { Chat } from "../../src/shared/chat";
import type { ChatSnapshot } from "../../src/shared/chat-transcript";
import type { Task } from "../../src/shared/task";
import type { HarnessActivitySnapshot } from "../../src/shared/harness-control";
import { createNativeMeshPeer } from "../helpers/mesh-native-peer";
import type { AgentSession } from "../../src/backends/types";
import type { ExecutionHostDescriptor } from "../../src/shared/execution-host";

const root = resolve(".cache/mesh-native-tests");

// Regression: real native questions must survive the controller/worker route,
// hydrate on repeated reads, validate owned answers and continue the same turn.
// The executable is the external provider seam; assertions use HTTP, persisted
// snapshots and the worker's observed protocol response rather than delegation.
test("Mesh native chat questions wait, accept owned answers once and expire after restart", async () => {
  const binaryDir = await createRuntime();
  const nodes: ManagedMeshNode[] = [];
  try {
    const controller = await startNode("controller", binaryDir); nodes.push(controller);
    const worker = await startNode("worker", binaryDir); nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const status = await meshJsonRequest<{ workers: Array<{ workerNodeId: string }> }>(controller, "/api/mesh/status");
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "Question workflow", directory: worker.dataDir, workspaceType: "directory",
      executionHost: { kind: "mesh", nodeId: status.body.workers[0]!.workerNodeId },
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(workspace.status).toBe(201);
    const createChat = async () => {
      const result = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
        workspaceId: workspace.body.id, useWorktree: false,
        model: { providerID: "codex", modelID: "fixture-model", variant: "" },
      } });
      expect(result.status).toBe(201);
      return result.body.config.id;
    };
    const id = await createChat();
    const other = await createChat();
    const read = async () => (await meshJsonRequest<Chat>(controller, `/api/chats/${id}`)).body;
    const ask = async () => {
      expect((await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: { message: "question-fixture" } })).status).toBe(200);
      return pollUntil(read, (chat) => chat.state.status === "waiting" && chat.state.harness?.questions?.at(-1)?.status === "pending", {
        description: "native human question stays pending instead of ending the prompt", timeoutMs: 10_000,
      });
    };
    const waiting = await ask();
    const request = waiting.state.harness!.questions!.at(-1)!;
    expect(waiting.state.error).toBeUndefined();
    expect((await read()).state.harness?.questions?.at(-1)).toEqual(request);
    expect((await meshJsonRequest(controller, `/api/chats/${other}/questions/${request.requestId}`, { body: { answers: [["Merge"]] } })).status).toBe(404);
    expect((await meshJsonRequest(controller, `/api/chats/${id}/questions/${request.requestId}`, { body: { answers: [["Merge", "Rebase"]] } })).status).toBe(400);
    const answer = { answers: [["Keep separate branches"]] };
    const path = `/api/chats/${id}/questions/${request.requestId}`;
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(200);
    const settled = await pollUntil(async () => (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body,
      (chat) => chat.state.status === "idle" && chat.state.harness?.questions?.at(-1)?.status === "answered"
        && chat.transcript.messages.some((message) => message.role === "assistant" && message.content.includes("Keep separate branches")), {
      description: "native callback consumes free-text answer and completes its original turn", timeoutMs: 10_000,
      formatLastObserved: (value) => JSON.stringify(value),
    });
    expect(settled.state.session?.id).toBe(waiting.state.session?.id);
    const transcript = await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`);
    expect(transcript.body.transcript.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Keep separate branches") }),
    ]));
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(200);
    expect((await meshJsonRequest(controller, path, { body: { answers: [["Rebase"]] } })).status).toBe(409);
    const again = await ask();
    expect(again.state.harness?.questions?.at(-1)?.requestId).not.toBe(request.requestId);
    expect((await meshJsonRequest(controller, `/api/chats/${id}/interrupt`, { body: {} })).status).toBe(200);
    const interrupted = await pollUntil(read, (chat) => chat.state.status === "idle", { description: "Stop releases human input", timeoutMs: 10_000 });
    expect(["expired", "cancelled"]).toContain(interrupted.state.harness?.questions?.at(-1)?.status ?? "");
    const beforeRestart = await ask();
    const expiredId = beforeRestart.state.harness!.questions!.at(-1)!.requestId;
    await restartMeshNode(controller);
    const restarted = await read();
    expect(restarted.state.status).toBe("stopped");
    expect(restarted.state.harness?.questions?.at(-1)?.status).toBe("expired");
    expect((await meshJsonRequest(controller, `/api/chats/${id}/questions/${expiredId}`, { body: answer })).status).toBe(409);

    // The real task boundary must derive unattended policy, not just a caller
    // manually constructing a native binding. This protects the selected-host
    // effect and logical completion from an accidentally interactive session.
    // Async questions have a separate native registration gate: execute the
    // session-owned hook at the external seam and require autonomous completion.
    const repository = join(worker.dataDir, "question-task");
    const exec = async (command: string, args: string[]) => {
      const result = await meshJsonRequest<{ exitCode: number; stdout: string }>(controller, `/api/workspaces/${workspace.body.id}/exec`, {
        body: { command, args, cwd: worker.dataDir },
      });
      expect(result.status).toBe(200);
      expect(result.body.exitCode).toBe(0);
      return result.body.stdout.trim();
    };
    await exec("mkdir", ["-p", repository]);
    await exec("git", ["-C", repository, "init"]);
    await exec("git", ["-C", repository, "config", "user.name", "Synthetic native questions"]);
    await exec("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    await exec("git", ["-C", repository, "commit", "--allow-empty", "-m", "Initialize synthetic repository"]);
    const branch = await exec("git", ["-C", repository, "branch", "--show-current"]);
    const taskWorkspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "Unattended question policy", directory: repository, workspaceType: "git",
      executionHost: { kind: "mesh", nodeId: status.body.workers[0]!.workerNodeId },
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(taskWorkspace.status).toBe(201);
    const taskCreated = await meshJsonRequest<Task>(controller, "/api/tasks", { body: {
      name: "Autonomous question task", workspaceId: taskWorkspace.body.id, prompt: "async-question-fixture",
      model: { providerID: "codex", modelID: "fixture-model", variant: "" }, cheapModel: { mode: "same-as-task" },
      baseBranch: branch, useWorktree: true, autoAcceptPlan: true,
      uploadedPlan: { planContent: "# Approved fixture plan\n\nasync-question-fixture" },
      stopPattern: "COMPLETE", maxIterations: 1, maxConsecutiveErrors: 1,
      attachments: [], git: { branchPrefix: "", commitScope: "" },
      clearPlanningFolder: false, fullyAutonomous: false, draft: false,
    } });
    expect(taskCreated.status).toBe(201);
    const task = await pollUntil(async () => (await meshJsonRequest<Task>(controller, `/api/tasks/${taskCreated.body.config.id}`)).body,
      (value) => value.state.status === "completed" || value.state.status === "failed" || value.state.status === "stopped",
      { description: "unattended native task completes without human input", timeoutMs: 20_000, formatLastObserved: (value) => JSON.stringify(value) });
    expect(task.state.status).toBe("completed");
    expect(task.state.session?.binding?.questionPolicy).toBe("unattended");
    const taskDirectory = task.state.git?.worktreePath;
    expect(taskDirectory).toBeDefined();
    expect(await Bun.file(join(taskDirectory!, `autonomous-${task.state.session!.id}.txt`)).text()).toBe("completed without requesting human input");
  } finally {
    for (const node of nodes.reverse()) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 60_000);

// A missing native receipt after irreversible admission must remain uncertain.
// This HTTP workflow protects against blind retries using persisted state and
// the provider's file effect, independently of adapter/Core decomposition.
test("native chat answer admission loss preserves uncertainty without sending the answer twice", async () => {
  const binaryDir = await createRuntime("opencode2");
  let controller: ManagedMeshNode | undefined;
  try {
    controller = await startNode("controller", binaryDir);
    const hosts = await meshJsonRequest<ExecutionHostDescriptor[]>(controller, "/api/execution-hosts");
    const local = hosts.body.find((host) => host.ref.kind === "local")!;
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "Uncertain native question", directory: controller.dataDir, workspaceType: "directory",
      executionHost: local.ref, serverSettings: { agent: { adapter: "opencode2", provider: "opencode" } },
    } });
    expect(workspace.status).toBe(201);
    const created = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
      workspaceId: workspace.body.id, useWorktree: false,
      model: { providerID: "opencode", modelID: "fixture-model", variant: "" },
    } });
    expect(created.status).toBe(201);
    const id = created.body.config.id;
    const sent = await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: { message: "Ask for a color" } });
    expect(sent).toMatchObject({ status: 200 });
    const node = controller;
    const read = async () => (await meshJsonRequest<Chat>(node, `/api/chats/${id}`)).body;
    const pending = await pollUntil(read, (chat) => chat.state.status === "waiting" && chat.state.harness?.questions?.at(-1)?.status === "pending",
      { description: "native form stays answerable", timeoutMs: 10_000 });
    const requestId = pending.state.harness!.questions!.at(-1)!.requestId;
    const path = `/api/chats/${id}/questions/${requestId}`;
    const answer = { answers: [["Blue"]] };
    const result = await meshJsonRequest<{ error: string }>(controller, path, { body: answer });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("harness_question_unconfirmed");
    expect((await read()).state.harness?.questions?.at(-1)).toMatchObject({ status: "unconfirmed", answers: [["Blue"]] });
    expect(await meshJsonRequest(controller, path, { body: answer })).toMatchObject({
      status: 409, body: { error: "harness_question_closed" },
    });
    expect(await Bun.file(join(controller.dataDir, "native-answer-effects.json")).json()).toEqual([{ color: "Blue" }]);
    await restartMeshNode(controller);
    expect((await read()).state.harness?.questions?.at(-1)?.status).toBe("expired");
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(409);
    expect(await Bun.file(join(controller.dataDir, "native-answer-effects.json")).json()).toEqual([{ color: "Blue" }]);
  } finally {
    if (controller) { controller.child.kill(); await controller.child.exited; await rm(controller.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

async function createRuntime(adapter: "codex" | "opencode2" = "codex"): Promise<string> {
  await mkdir(root, { recursive: true });
  const binaryDir = await mkdtemp(join(root, "runtime-"));
  const executable = join(binaryDir, adapter);
  const fixture = adapter === "codex" ? "native-mesh-codex.ts" : "opencode-question-runtime.ts";
  await Bun.write(executable, `#!/bin/sh\nexec "${process.execPath}" "${resolve(`tests/fixtures/${fixture}`)}" "$@"\n`);
  await chmod(executable, 0o755);
  return binaryDir;
}

async function startNode(role: "controller" | "worker", path: string): Promise<ManagedMeshNode> {
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, `${role}-`));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env, PATH: `${path}:${process.env["PATH"]}`,
    CLANKY_DATA_DIR: dataDir, CLANKY_PORT: String(port), CLANKY_HOST: "127.0.0.1",
    CLANKY_PUBLIC_BASE_URL: baseUrl, CLANKY_LOG_LEVEL: "fatal",
    CLANKY_DISABLE_PASSKEY: role === "controller" ? "true" : undefined,
  };
  const command = [process.execPath, "src/index.ts"];
  let apiKey: string | undefined;
  if (role === "worker") {
    const result = Bun.spawnSync([...command, "worker", "bootstrap", "--host", "127.0.0.1", "--port", String(port), "--worker-directory", dataDir, "--mesh-endpoint", baseUrl, "--instance-name", "native-fixture", "--insecure"], {
      env: environment, stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      await rm(dataDir, { recursive: true, force: true });
      throw new Error(result.stderr.toString());
    }
    apiKey = (JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as { apiKey: string }).apiKey;
  }
  const serveArguments = ["serve", ...(role === "worker" ? ["--mesh-worker", "true", "--worker-directory", dataDir] : [])];
  const child = Bun.spawn([...command, ...serveArguments], { env: environment, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const output = { stdout: Promise.resolve(""), stderr: Promise.resolve(""), snapshot: () => "" };
  const node: ManagedMeshNode = { role, command, environment, serveArguments, child, dataDir, baseUrl, apiKey, output, generation: 1 };
  try {
    await pollUntil(async () => fetch(`${baseUrl}/api/health`).then((response) => response.ok).catch(() => false), (ready) => ready, { description: `native Mesh ${role} health`, timeoutMs: 15_000 });
    return node;
  } catch (error) {
    child.kill(); await child.exited;
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

// Regression: native work must cross the real controller/worker boundary
// without ACP framing, while message completion, descendant completion and
// Stop remain independent of the principal. A runtime executable is the only
// external double; HTTP state and host filesystem/process effects are contracts.
test("Mesh v6 native catalog, lifetime activity, steering and scoped Stop preserve the principal and owned host effects", async () => {
  const binaryDir = await createRuntime();
  const nodes: ManagedMeshNode[] = [];
  try {
    const controller = await startNode("controller", binaryDir); nodes.push(controller);
    const worker = await startNode("worker", binaryDir); nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const status = await meshJsonRequest<{ workers: Array<{ workerNodeId: string; workerNegotiatedProtocolVersion: number }> }>(controller, "/api/mesh/status");
    expect(status.body.workers[0]!.workerNegotiatedProtocolVersion).toBe(6);
    const workerId = status.body.workers[0]!.workerNodeId;
    const targets = await meshJsonRequest<ExecutionHostDescriptor[]>(controller, "/api/workspaces/execution-targets");
    expect(targets.status).toBe(200);
    expect(targets.body.find((host) => host.ref.kind === "mesh" && host.ref.nodeId === workerId)?.harnessAdapters)
      .toEqual(["acp", "copilot", "codex", "opencode2"]);
    const git = Bun.spawnSync(["git", "-C", worker.dataDir, "init"], { stdout: "ignore", stderr: "pipe" });
    expect(git.exitCode).toBe(0);
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "native Mesh", directory: `${worker.dataDir}/`,
      executionHost: { kind: "mesh", nodeId: workerId },
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(workspace.status).toBe(201);
    const connection = await meshJsonRequest<{ success: boolean }>(controller, "/api/server-settings/test", { body: {
      directory: worker.dataDir, executionHost: { kind: "mesh", nodeId: workerId },
      settings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(connection).toMatchObject({ status: 200, body: { success: true } });
    const catalog = await meshJsonRequest<Array<{ modelID: string }>>(controller, `/api/models?workspaceId=${workspace.body.id}`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.some((model) => model.modelID === "fixture-model")).toBe(true);
    const created = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
      workspaceId: workspace.body.id, useWorktree: false, name: "native owned conversation",
      model: { providerID: "codex", modelID: "fixture-model", variant: "" },
    } });
    expect(created.status).toBe(201);
    const chatId = created.body.config.id;
    const sent = await meshJsonRequest(controller, `/api/chats/${chatId}/messages`, { body: { message: "start native work" } });
    expect(sent.status).toBe(200);
    const activity = async (): Promise<HarnessActivitySnapshot> => (await meshJsonRequest<{ activity: HarnessActivitySnapshot }>(controller, `/api/chats/${chatId}/activity`)).body.activity;
    const initial = await pollUntil(activity, (snapshot) => snapshot?.observation === "available" && snapshot.activities.length === 2, { description: "owned native descendants on selected Mesh host", timeoutMs: 15_000 });
    expect(initial.observation).toBe("available");
    if (initial.observation !== "available") throw new Error("Activity unavailable");
    expect(initial.principalProcessing).toBe(true);
    expect(await Bun.file(join(worker.dataDir, "native-host-effect.txt")).text()).toContain(worker.dataDir);
    const runningChat = (await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body;
    expect(runningChat.state.status).toBe("streaming");
    expect(runningChat.state.session?.binding?.directory).toBe(`${worker.dataDir}/`);
    const first = initial.activities.find((entry) => entry.id.endsWith("-one"))!;
    const second = initial.activities.find((entry) => entry.id.endsWith("-two"))!;
    const stopped = await meshJsonRequest<{ result: { status: string; activityId: string } }>(controller, `/api/chats/${chatId}/activity/${encodeURIComponent(first.id)}/stop`, { body: {} });
    expect(stopped.status).toBe(200);
    expect(stopped.body.result.status).toBe("stopped");
    expect(stopped.body.result.activityId).toBe(first.id);
    const afterStop = await activity();
    expect(afterStop).toMatchObject({ observation: "available", principalProcessing: true });
    if (afterStop.observation !== "available") throw new Error("Activity unavailable after Stop");
    expect(afterStop.activities.find((entry) => entry.id === second.id)?.status).toBe("running");
    expect(await Bun.file(join(worker.dataDir, `.fixture-stopped-${first.id}`)).text()).toBe("settled");
    const invalidInput = await meshJsonRequest<{ chat: Chat }>(controller, `/api/chats/${chatId}/messages`, { body: {
      message: "Unsupported native attachment",
      attachments: [{ id: crypto.randomUUID(), filename: "document.pdf", mimeType: "application/pdf", data: "JVBERg==", size: 4 }],
    } });
    const invalidId = invalidInput.body.chat.state.queuedMessages![0]!.id;
    expect(await meshJsonRequest(controller, `/api/chats/${chatId}/queued-messages/${invalidId}/steer`, { body: {} })).toMatchObject({
      status: 409, body: { error: "harness_unsupported_feature" },
    });
    const rejected = (await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body;
    expect(rejected.state.status).toBe("streaming");
    expect(rejected.state.harness?.inputs?.find((receipt) => receipt.admission.inputId === invalidId)?.admission).toEqual({
      status: "rejected", inputId: invalidId, code: "unsupported",
    });
    expect((await meshJsonRequest(controller, `/api/chats/${chatId}/queued-messages/${invalidId}`, { method: "DELETE" })).status).toBe(200);
    // Without native recovery references, reconciliation stays unknown. That
    // must preserve the original input and forbid discarding it.
    const lostResponse = join(worker.dataDir, ".fixture-steer-response-loss");
    await Bun.write(lostResponse, "lose the response after native admission");
    const uncertain = await meshJsonRequest<{ chat: Chat }>(controller, `/api/chats/${chatId}/messages`, { body: { message: "admit without a usable response" } });
    const uncertainId = uncertain.body.chat.state.queuedMessages![0]!.id;
    expect((await meshJsonRequest(controller, `/api/chats/${chatId}/queued-messages/${uncertainId}/steer`, { body: {} })).body).toMatchObject({
      admission: { status: "unknown", inputId: uncertainId },
    });
    const uncertainRecovery = await meshJsonRequest<{ admission: { status: string; inputId: string } }>(controller, `/api/chats/${chatId}/queued-messages/${uncertainId}/reconcile`, { body: {} });
    expect(uncertainRecovery.status).toBe(200);
    expect(["unknown", "delivered"]).toContain(uncertainRecovery.body.admission.status);
    if (uncertainRecovery.body.admission.status === "unknown") {
      expect(uncertainRecovery.body.admission.inputId).toBe(uncertainId);
      expect((await meshJsonRequest(controller, `/api/chats/${chatId}/queued-messages/${uncertainId}`, { method: "DELETE" })).status).toBe(409);
    } else {
      expect(uncertainRecovery.body.admission).toMatchObject({
        inputId: uncertainId, nativeClientInputId: uncertainId, nativeMessageId: `admitted-${uncertainId}`,
      });
    }
    await unlink(lostResponse);
    expect((await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body.state.status).toBe("streaming");
    const queued = await meshJsonRequest<{ chat: Chat }>(controller, `/api/chats/${chatId}/messages`, { body: { message: "finish principal" } });
    expect(queued.status).toBe(200);
    const inputId = queued.body.chat.state.queuedMessages!.at(-1)!.id;
    const steering = await meshJsonRequest<{ admission: { status: string; inputId: string; nativeClientInputId: string } }>(controller, `/api/chats/${chatId}/queued-messages/${inputId}/steer`, { body: {} });
    expect(steering.status).toBe(200);
    expect(steering.body.admission).toMatchObject({ status: "accepted", inputId, nativeClientInputId: inputId });
    await pollUntil(async () => (await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body, (chat) => chat.state.status === "idle", { description: "principal native turn settles without child settlement", timeoutMs: 15_000, formatLastObserved: (chat) => JSON.stringify(chat) });
    if (uncertainRecovery.body.admission.status === "unknown") {
      expect((await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body.state.queuedMessages).toContainEqual(expect.objectContaining({ id: uncertainId }));
    }
    const afterTurn = await activity();
    expect(afterTurn).toMatchObject({ observation: "available", principalProcessing: false });
    if (afterTurn.observation !== "available") throw new Error("Lifetime activity unavailable after turn");
    expect(afterTurn.activities.find((entry) => entry.id === second.id)?.status).toBe("running");
    const recovered = await meshJsonRequest<{ admission: { status: string; inputId: string; nativeMessageId: string } }>(controller, `/api/chats/${chatId}/queued-messages/${inputId}/reconcile`, { body: {} });
    expect(recovered.status).toBe(200);
    expect(recovered.body.admission).toMatchObject({ status: "delivered", inputId, nativeMessageId: `admitted-${inputId}` });
    // Failed native inventory is unavailable, never a successful empty graph.
    const failureFlag = join(worker.dataDir, ".fixture-observation-failure");
    await Bun.write(failureFlag, "fail the genuine external protocol query");
    expect(await activity()).toMatchObject({ observation: "unavailable" });
    await unlink(failureFlag);
    await pollUntil(async () => (await meshJsonRequest<Chat>(controller, `/api/chats/${chatId}`)).body.state.harness?.activity,
      (snapshot) => snapshot?.observation === "available", {
        description: "server inventory reconciliation recovers without an activity refresh request",
        timeoutMs: 10_000, formatLastObserved: (snapshot) => JSON.stringify(snapshot),
      });

    // Public signed-peer coverage protects cold ownership and actual expiry.
    // The controller key is a credential at this genuine external seam.
    const peer = await createNativeMeshPeer(controller, worker);
    const owner = { workspaceId: workspace.body.id, ownerId: "mesh-owned-user" };
    const lease = await peer.open(owner);
    const replayId = crypto.randomUUID();
    const owned = await lease.rpc<AgentSession>({ operation: "create", options: {
      directory: worker.dataDir, ownership: { ownerId: owner.ownerId, contextId: "mesh-cold-conversation" },
    } }, { requestId: replayId });
    expect(owned.status).toBe(200);
    expect(owned.body.binding?.nativeId).toBe(owned.body.id);
    expect(await lease.rpc<{ error: string }>({ operation: "create", options: {
      directory: worker.dataDir, ownership: { ownerId: owner.ownerId, contextId: "mesh-cold-conversation" },
    } }, { requestId: replayId })).toMatchObject({ status: 400, body: { error: "mesh_execution_replay" } });
    await lease.close();
    const wrongOwner = await peer.open({ ...owner, ownerId: "different-user" });
    expect((await wrongOwner.rpc({ operation: "resume", binding: { ...owned.body.binding!, ownerId: "different-user" } })).status).toBe(409);
    await wrongOwner.close();
    const wrongWorkspace = await peer.open({ ...owner, workspaceId: crypto.randomUUID() });
    expect((await wrongWorkspace.rpc({ operation: "resume", binding: owned.body.binding! })).status).toBe(409);
    await wrongWorkspace.close();
    const foreignController = await startNode("controller", binaryDir); nodes.push(foreignController);
    await enrollMeshWorker(foreignController, worker);
    const foreignPeer = await createNativeMeshPeer(foreignController, worker);
    const foreignLease = await foreignPeer.open(owner);
    expect((await foreignLease.rpc({ operation: "resume", binding: owned.body.binding! })).status).toBe(409);
    await foreignLease.close();
    const resumedLease = await peer.open(owner);
    const resumed = await resumedLease.rpc<AgentSession>({ operation: "resume", binding: owned.body.binding! });
    expect(resumed.status).toBe(200);
    expect(resumed.body.binding).toEqual(owned.body.binding);
    expect(resumed.body.id).toBe(owned.body.id);
    const sibling = await resumedLease.rpc<AgentSession>({ operation: "create", options: {
      directory: worker.dataDir, ownership: { ownerId: owner.ownerId, contextId: "mesh-independent-conversation" },
    } });
    expect(sibling.status).toBe(200);
    expect((await resumedLease.rpc({ operation: "prompt", sessionId: sibling.body.id, prompt: { parts: [{ type: "text", text: "start independent native work" }] } })).status).toBe(200);
    const observing = await resumedLease.observe(resumed.body.id);
    expect(observing.status).toBe(200);
    const reader = observing.body!.getReader();
    await reader.read();
    expect((await resumedLease.rpc({ operation: "delete", sessionId: resumed.body.id })).status).toBe(200);
    await reader.cancel(); reader.releaseLock();
    expect((await resumedLease.rpc<HarnessActivitySnapshot>({ operation: "activity", sessionId: sibling.body.id })).body).toMatchObject({
      observation: "available", principalProcessing: true, activities: expect.arrayContaining([expect.objectContaining({ status: "running" })]),
    });
    const disconnectedStream = await resumedLease.observe(sibling.body.id);
    const disconnectedReader = disconnectedStream.body!.getReader();
    await disconnectedReader.read();
    await disconnectedReader.cancel(); disconnectedReader.releaseLock();
    await pollUntil(async () => Bun.file(join(worker.dataDir, `.fixture-stopped-${sibling.body.id}-two`)).exists(), (exists) => exists, { description: "lost native lifetime stream settles its owned subprocesses", timeoutMs: 5_000 });
    expect((await resumedLease.rpc({ operation: "get", sessionId: sibling.body.id })).status).toBe(401);
    await resumedLease.close();
    const expiring = await peer.open({ ...owner, ttlMs: 4_000 });
    const expiringSession = await expiring.rpc<AgentSession>({ operation: "create", options: {
      directory: worker.dataDir, ownership: { ownerId: owner.ownerId, contextId: "mesh-expiring-conversation" },
    } });
    expect(expiringSession.status).toBe(200);
    expect((await expiring.rpc({ operation: "prompt", sessionId: expiringSession.body.id, prompt: { parts: [{ type: "text", text: "start native work" }] } })).status).toBe(200);
    await pollUntil(async () => Bun.file(join(worker.dataDir, `.fixture-stopped-${expiringSession.body.id}-two`)).exists(), (exists) => exists, { description: "expired native lease settles its real subprocesses", timeoutMs: 10_000 });
    expect((await expiring.rpc({ operation: "get", sessionId: expiringSession.body.id })).status).toBe(401);
    const independent = await activity();
    expect(independent.observation).toBe("available");
    if (independent.observation !== "available") throw new Error("Independent lease unavailable after expiry");
    expect(independent.activities.find((entry) => entry.id === second.id)?.status).toBe("running");
    const revoked = await meshJsonRequest(controller, "/api/mesh/workers/revoke", { body: { workerNodeId: workerId } });
    expect(revoked.status).toBe(200);
    await pollUntil(async () => Bun.file(join(worker.dataDir, `.fixture-stopped-${second.id}`)).exists(), (exists) => exists, { description: "revoked native lease settles owned worker subprocesses", timeoutMs: 15_000 });
    expect((await meshJsonRequest(worker, "/api/mesh/status")).status).toBe(200);
    expect((await meshJsonRequest(controller, "/api/mesh/status")).status).toBe(200);
  } finally {
    for (const node of nodes.reverse()) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 60_000);

// This distinct transport boundary proves native encrypted RPC and lifetime
// NDJSON survive real relay WS forwarding, not just the direct worker path.
test("Mesh v6 native harness executes and observes owned descendants through a real relay", async () => {
  const binaryDir = await createRuntime();
  const nodes: ManagedMeshNode[] = [];
  const relayData = await mkdtemp(join(root, "relay-"));
  let relay: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const controller = await startNode("controller", binaryDir); nodes.push(controller);
    const worker = await startNode("worker", binaryDir); nodes.push(worker);
    const controllerStatus = await meshJsonRequest<{ node: { fingerprint: string } }>(controller, "/api/mesh/status");
    const relayPort = await availablePort();
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    relay = Bun.spawn([process.execPath, "src/index.ts", "relay"], {
      env: { ...process.env, CLANKY_DATA_DIR: relayData, CLANKY_HOST: "127.0.0.1", CLANKY_PORT: String(relayPort),
        CLANKY_RELAY_CONTROLLER_FINGERPRINT: controllerStatus.body.node.fingerprint, CLANKY_LOG_LEVEL: "fatal",
      }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await pollUntil(async () => fetch(`${relayUrl}/api/health`).then((response) => response.ok).catch(() => false), (healthy) => healthy, { description: "native Mesh relay health", timeoutMs: 15_000 });
    expect((await meshJsonRequest(controller, "/api/mesh/relay", { body: { name: "native", relayUrl } })).status).toBe(201);
    const invitation = await meshJsonRequest<{ token: string; enrollment: { controllerFingerprint: string } }>(controller, "/api/mesh/enrollment-tokens", { body: { name: "native relay", route: "relay", ttlSeconds: 900 } });
    expect(invitation.status).toBe(201);
    const joined = Bun.spawnSync([...worker.command, "worker", "join", relayUrl, "--token", invitation.body.token, "--fingerprint", invitation.body.enrollment.controllerFingerprint], {
      env: worker.environment, stdout: "ignore", stderr: "pipe",
    });
    expect(joined.exitCode).toBe(0);
    await restartMeshNode(worker);
    const status = await meshJsonRequest<{ workers: Array<{ workerNodeId: string; workerNegotiatedProtocolVersion: number; route: { kind: string } }> }>(controller, "/api/mesh/status");
    const registered = status.body.workers[0]!;
    expect(registered).toMatchObject({ workerNegotiatedProtocolVersion: 6, route: { kind: "relay" } });
    const targets = await meshJsonRequest<ExecutionHostDescriptor[]>(controller, "/api/workspaces/execution-targets");
    expect(targets.status).toBe(200);
    expect(targets.body.find((host) => host.ref.kind === "mesh" && host.ref.nodeId === registered.workerNodeId)?.harnessAdapters)
      .toEqual(["acp", "copilot", "codex", "opencode2"]);
    expect(Bun.spawnSync(["git", "-C", worker.dataDir, "init"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "native relay", directory: worker.dataDir, executionHost: { kind: "mesh", nodeId: registered.workerNodeId },
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(workspace.status).toBe(201);
    expect((await meshJsonRequest<Array<{ modelID: string }>>(controller, `/api/models?workspaceId=${workspace.body.id}`)).body).toContainEqual(expect.objectContaining({ modelID: "fixture-model" }));
    const chat = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
      workspaceId: workspace.body.id, useWorktree: false, model: { providerID: "codex", modelID: "fixture-model", variant: "" },
    } });
    expect(chat.status).toBe(201);
    const id = chat.body.config.id;
    expect((await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: { message: "start native relay work" } })).status).toBe(200);
    const activity = await pollUntil(async () => (await meshJsonRequest<{ activity: HarnessActivitySnapshot }>(controller, `/api/chats/${id}/activity`)).body.activity,
      (snapshot) => snapshot?.observation === "available" && snapshot.activities.length === 2,
      { description: "native relay lifetime descendants", timeoutMs: 15_000 });
    expect(activity).toMatchObject({ observation: "available", principalProcessing: true });
    expect(await Bun.file(join(worker.dataDir, "native-host-effect.txt")).text()).toContain(worker.dataDir);
    if (activity.observation !== "available") throw new Error("Native relay activity unavailable");
    expect((await meshJsonRequest(controller, `/api/chats/${id}/activity/${encodeURIComponent(activity.activities[0]!.id)}/stop`, { body: {} })).status).toBe(200);
    expect((await meshJsonRequest<Chat>(controller, `/api/chats/${id}`)).body.state.status).toBe("streaming");
  } finally {
    for (const node of nodes.reverse()) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    relay?.kill(); await relay?.exited;
    await rm(relayData, { recursive: true, force: true });
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 60_000);
