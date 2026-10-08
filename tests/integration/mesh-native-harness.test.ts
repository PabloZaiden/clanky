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
import { MESH_PROTOCOL_VERSION } from "../../src/shared/mesh-protocol";

const root = resolve(".cache/mesh-native-tests");

// Regression: real native questions must survive the controller/worker route
// and reconnects, hydrate on repeated reads, validate owned answers and continue
// the same turn. Stop must cancel the request rather than expire it.
// The executable is the external provider seam; assertions use HTTP, persisted
// snapshots and the worker's observed protocol response rather than delegation.
// This is the existing highest-boundary question workflow; reconnect coverage
// does not depend on the Core/adapter decomposition.
test("Mesh native chat questions survive reconnects, accept owned answers once and cancel on Stop", async () => {
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
    expect((await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot`)).body.transcript.messages
      .filter((message) => message.question?.requestId === request.requestId))
      .toMatchObject([{ role: "assistant", content: request.questions[0]!.question }]);
    expect(waiting.state.error).toBeUndefined();
    expect((await read()).state.harness?.questions?.at(-1)).toEqual(request);
    const reconnects = await Promise.all(Array.from({ length: 2 }, () =>
      meshJsonRequest<Chat>(controller, `/api/chats/${id}/reconnect`, { body: {} })));
    for (const reconnected of reconnects) {
      expect(reconnected.status).toBe(200);
      expect(reconnected.body.state.status).toBe("waiting");
      expect(reconnected.body.state.session).toEqual(waiting.state.session);
      expect(reconnected.body.state.harness?.questions?.at(-1)).toEqual(request);
    }
    expect((await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot`)).body.state.harness?.questions?.at(-1)).toEqual(request);
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
      expect.objectContaining({ role: "assistant", content: request.questions[0]!.question }),
      expect.objectContaining({ role: "user", content: answer.answers[0]![0] }),
    ]));
    const dialogue = transcript.body.transcript.messages.filter((message) => message.question?.requestId === request.requestId);
    expect(dialogue).toMatchObject([
      { role: "assistant", question: { status: "answered", scope: { kind: "principal" } } },
      { role: "user", question: { status: "answered" } },
    ]);
    const continuation = transcript.body.transcript.messages.find((message) => !message.question && message.role === "assistant")!;
    expect(dialogue[0]!.timestamp < dialogue[1]!.timestamp).toBe(true);
    expect(dialogue[1]!.timestamp < continuation.timestamp).toBe(true);
    expect(transcript.body.transcript.totalResponses).toBe(transcript.body.transcript.messages
      .filter((message) => message.role === "assistant" && message.content.length > 0).length);
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(200);
    const repeated = (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body.transcript;
    expect(repeated.messages.filter((message) => message.question?.requestId === request.requestId)).toEqual(dialogue);
    expect(repeated.totalEntries).toBe(transcript.body.transcript.totalEntries);
    for (const extension of ["md", "html"]) {
      const exported = await meshJsonRequest<string>(controller, `/api/chats/${id}/transcript.${extension}`, { responseType: "text" });
      expect(exported.status).toBe(200);
      expect(exported.body).toContain(request.questions[0]!.question);
      expect(exported.body).toContain(answer.answers[0]![0]!);
    }
    expect((await meshJsonRequest(controller, path, { body: { answers: [["Rebase"]] } })).status).toBe(409);
    const again = await ask();
    expect(again.state.harness?.questions?.at(-1)?.requestId).not.toBe(request.requestId);
    expect((await meshJsonRequest(controller, `/api/chats/${id}/interrupt`, { body: {} })).status).toBe(200);
    const interrupted = await pollUntil(read, (chat) => chat.state.status === "idle", { description: "Stop releases human input", timeoutMs: 10_000 });
    expect(interrupted.state.harness?.questions?.at(-1)?.status).toBe("cancelled");
    expect((await meshJsonRequest(controller, `/api/chats/${id}/questions/${again.state.harness!.questions!.at(-1)!.requestId}`, { body: answer })).status).toBe(409);
    const beforeRestart = await ask();
    const expiredId = beforeRestart.state.harness!.questions!.at(-1)!.requestId;
    await restartMeshNode(controller);
    const restarted = await read();
    expect((await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body.transcript.messages
      .filter((message) => message.question?.requestId === request.requestId)).toEqual(dialogue);
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

// Cancelled native questions are not pending capacity. Exceed the real Mesh
// interaction limit across short completed turns, then require a fresh owned
// answer and native file effect through both gateway and controller proxy.
// Existing tests cover single cancellations, not lifetime capacity recovery.
test("Mesh native resolved questions release capacity for later owned answers", async () => {
  const binaryDir = await createRuntime("opencode2");
  const nodes: ManagedMeshNode[] = [];
  try {
    const controller = await startNode("controller", binaryDir); nodes.push(controller);
    const worker = await startNode("worker", binaryDir); nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    await Bun.write(join(worker.dataDir, "confirm-native-answers"), "confirm native replies");
    const status = await meshJsonRequest<{ workers: Array<{ workerNodeId: string }> }>(controller, "/api/mesh/status");
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "Resolved native question capacity", directory: worker.dataDir, workspaceType: "directory",
      executionHost: { kind: "mesh", nodeId: status.body.workers[0]!.workerNodeId },
      serverSettings: { agent: { adapter: "opencode2", provider: "opencode" } },
    } });
    expect(workspace.status).toBe(201);
    const created = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
      name: "Resolved questions", workspaceId: workspace.body.id, useWorktree: false,
      model: { providerID: "opencode", modelID: "fixture-model", variant: "" },
    } });
    expect(created.status).toBe(201);
    const id = created.body.config.id;
    const read = async () => (await meshJsonRequest<Chat>(controller, `/api/chats/${id}`)).body;
    expect((await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: { message: "multi-question-fixture" } })).status).toBe(200);
    const first = await pollUntil(read, (chat) => chat.state.status === "waiting" && chat.state.harness?.questions?.at(-1)?.status === "pending", {
      description: "multiple native form fields become answerable", timeoutMs: 10_000,
    });
    const firstRequest = first.state.harness!.questions!.at(-1)!;
    expect(firstRequest.questions).toHaveLength(4);
    expect((await meshJsonRequest(controller, `/api/chats/${id}/questions/${firstRequest.requestId}`, {
      body: { answers: [["Blue"], ["Git", "Tests"], ["Keep the working tree clean"], []] },
    })).status).toBe(200);
    const firstAnswered = await pollUntil(read, (chat) => chat.state.status === "idle" && chat.state.harness?.questions?.at(-1)?.status === "answered", {
      description: "multiselect and free-text native answer settles", timeoutMs: 10_000,
    });
    expect(firstAnswered.state.harness?.questions?.at(-1)?.status).toBe("answered");
    const firstDialogue = (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot`)).body.transcript.messages
      .filter((message) => message.question?.requestId === firstRequest.requestId);
    expect(firstDialogue).toMatchObject([{ role: "assistant" }, { role: "user", question: { status: "answered" } }]);
    for (const question of firstRequest.questions) expect(firstDialogue[0]!.content).toContain(question.question);
    for (const value of ["Blue", "Git", "Tests", "Keep the working tree clean"]) expect(firstDialogue[1]!.content).toContain(value);
    for (let cycle = 0; cycle < 33; cycle++) {
      const sent = await meshJsonRequest(controller, `/api/chats/${id}/messages`, {
        body: { message: `resolved-question-cycle:${cycle}` },
      });
      expect({ cycle, response: sent }).toMatchObject({ response: { status: 200 } });
      await pollUntil(read, (chat) => {
        if (chat.state.status === "failed") throw new Error(`Native question stream failed in turn ${cycle}: ${JSON.stringify(chat.state.error)}`);
        const last = chat.state.harness?.questions?.at(-1);
        return chat.state.status === "idle" && last?.requestId === `cycle-${cycle}-15` && last.status === "cancelled";
      }, {
        description: `native cancelled question turn ${cycle} settles`,
        timeoutMs: 10_000,
        formatLastObserved: (chat) => JSON.stringify({ status: chat.state.status, error: chat.state.error, question: chat.state.harness?.questions?.at(-1) }),
      });
    }
    expect((await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: { message: "Ask for a color" } })).status).toBe(200);
    const pending = await pollUntil(read, (chat) => chat.state.status === "waiting" && chat.state.harness?.questions?.at(-1)?.status === "pending", {
      description: "new question remains answerable after 528 native cancellations", timeoutMs: 10_000,
    });
    const requestId = pending.state.harness!.questions!.at(-1)!.requestId;
    expect((await meshJsonRequest(controller, `/api/chats/${id}/questions/${requestId}`, { body: { answers: [["Blue"]] } })).status).toBe(200);
    const settled = await pollUntil(read, (chat) => chat.state.status === "idle" && chat.state.harness?.questions?.at(-1)?.status === "answered", {
      description: "new owned answer reaches the native provider and settles", timeoutMs: 10_000,
    });
    expect(settled.state.error).toBeUndefined();
    expect(await Bun.file(join(worker.dataDir, "native-answer-effects.json")).json()).toEqual([
      { color: "Blue", tools: ["Git", "Tests"], details: "Keep the working tree clean" },
      { color: "Blue" },
    ]);
    let page = (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot`)).body.transcript;
    expect(page.hasOlder).toBe(true);
    let pages = 1;
    while (!page.messages.some((message) => message.id === firstDialogue[0]!.id)) {
      if (!page.nextCursor || pages++ > 10) throw new Error(`Earlier dialogue was not reachable: ${JSON.stringify(page)}`);
      page = (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?before=${encodeURIComponent(page.nextCursor)}`)).body.transcript;
    }
    expect(page.messages.filter((message) => message.question?.requestId === firstRequest.requestId)).toEqual(firstDialogue);
    const full = (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body.transcript;
    expect(full.messages.filter((message) => message.question?.requestId === firstRequest.requestId)).toEqual(firstDialogue);
    expect(full.totalResponses).toBe(full.messages.filter(
      (message) => message.role === "assistant" && message.content.length > 0,
    ).length);
  } finally {
    for (const node of nodes.reverse()) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 120_000);

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
      name: "Uncertain native answer", workspaceId: workspace.body.id, useWorktree: false,
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
    await Bun.write(join(node.dataDir, "gate-question-reconnect"), "");
    const reconnecting = meshJsonRequest<Chat>(node, `/api/chats/${id}/reconnect`, { body: {} });
    await pollUntil(async () => await Bun.file(join(node.dataDir, "native-reconnect-ready")).exists(),
      (ready) => ready, { description: "native reconnect reaches admission gate", timeoutMs: 10_000 });
    const answering = meshJsonRequest<{ error: string }>(node, path, { body: answer });
    await pollUntil(async () => await Bun.file(join(node.dataDir, "native-answer-ready")).exists(),
      (ready) => ready, { description: "native answer admitted before acknowledgement loss", timeoutMs: 10_000 });
    expect((await read()).state).toMatchObject({
      status: "reconnecting",
      harness: { questions: [expect.objectContaining({ requestId, status: "submitting" })] },
    });
    await Bun.write(join(node.dataDir, "release-question-reconnect"), "");
    const [result, answerReconnect] = await Promise.all([
      answering,
      reconnecting,
    ]);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("harness_question_unconfirmed");
    expect(answerReconnect.status).toBe(200);
    expect((await read()).state.status).toBe("waiting");
    expect((await read()).state.harness?.questions?.at(-1)).toMatchObject({ status: "unconfirmed", answers: [["Blue"]] });
    const uncertainDialogue = (await meshJsonRequest<ChatSnapshot>(node, `/api/chats/${id}/snapshot`)).body.transcript.messages
      .filter((message) => message.question?.requestId === requestId);
    expect(uncertainDialogue).toMatchObject([
      { role: "assistant", question: { status: "unconfirmed" } },
      { role: "user", content: "Blue", question: { status: "unconfirmed" } },
    ]);
    expect(await meshJsonRequest(controller, path, { body: answer })).toMatchObject({
      status: 409, body: { error: "harness_question_closed" },
    });
    expect(await Bun.file(join(controller.dataDir, "native-answer-effects.json")).json()).toEqual([{ color: "Blue" }]);
    const reconnected = await meshJsonRequest<Chat>(controller, `/api/chats/${id}/reconnect`, { body: {} });
    expect(reconnected).toMatchObject({ status: 200 });
    expect(reconnected.body.state.status).toBe("waiting");
    expect(reconnected.body.state.harness?.questions?.at(-1)).toMatchObject({ status: "unconfirmed", answers: [["Blue"]] });
    expect((await meshJsonRequest<ChatSnapshot>(node, `/api/chats/${id}/snapshot`)).body.transcript.messages
      .filter((message) => message.question?.requestId === requestId)).toEqual(uncertainDialogue);
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(409);
    expect(await Bun.file(join(controller.dataDir, "native-answer-effects.json")).json()).toEqual([{ color: "Blue" }]);
    await restartMeshNode(controller);
    expect((await read()).state.harness?.questions?.at(-1)?.status).toBe("expired");
    expect((await meshJsonRequest<ChatSnapshot>(node, `/api/chats/${id}/snapshot`)).body.transcript.messages
      .filter((message) => message.question?.requestId === requestId))
      .toMatchObject([{ role: "assistant" }, { role: "user", question: { status: "expired" } }]);
    expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(409);
    expect(await Bun.file(join(controller.dataDir, "native-answer-effects.json")).json()).toEqual([{ color: "Blue" }]);
  } finally {
    if (controller) { controller.child.kill(); await controller.child.exited; await rm(controller.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

// Regression: reconnect must preserve the actual Copilot SDK callback, not
// merely its persisted form. This exercises HTTP and the native SDK protocol,
// with a deterministic external runtime instead of a live provider or Backend
// mock. Codex's existing workflow cannot prove Copilot callback cancellation.
test("Copilot native questions survive client reconnects and Stop cancels the SDK callback", async () => {
  const binaryDir = await createRuntime("copilot");
  let controller: ManagedMeshNode | undefined;
  try {
    controller = await startNode("controller", binaryDir);
    const node = controller;
    const hosts = await meshJsonRequest<ExecutionHostDescriptor[]>(node, "/api/execution-hosts");
    const workspace = await meshJsonRequest<{ id: string }>(node, "/api/workspaces", { body: {
      name: "Copilot question reconnect", directory: node.dataDir, workspaceType: "directory",
      executionHost: hosts.body.find((host) => host.ref.kind === "local")!.ref,
      serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
    } });
    expect(workspace.status).toBe(201);
    const ask = async () => {
      const created = await meshJsonRequest<Chat>(node, "/api/chats", { body: {
        name: "Native Copilot question", workspaceId: workspace.body.id, useWorktree: false,
        model: { providerID: "copilot", modelID: "fixture-model", variant: "" },
      } });
      expect(created.status).toBe(201);
      const id = created.body.config.id;
      expect((await meshJsonRequest(node, `/api/chats/${id}/messages`, { body: { message: "Ask for a color" } })).status).toBe(200);
      const waiting = await pollUntil(async () => (await meshJsonRequest<Chat>(node, `/api/chats/${id}`)).body,
        (chat) => chat.state.status === "waiting" && chat.state.harness?.questions?.at(-1)?.status === "pending",
        { description: "Copilot SDK callback remains pending", timeoutMs: 10_000, formatLastObserved: (chat) => JSON.stringify(chat.state) });
      return waiting;
    };
    const waiting = await ask();
    const id = waiting.config.id;
    const question = waiting.state.harness!.questions!.at(-1)!;
    const reconnects = await Promise.all(Array.from({ length: 2 }, () =>
      meshJsonRequest<Chat>(node, `/api/chats/${id}/reconnect`, { body: {} })));
    for (const response of reconnects) {
      expect(response.status).toBe(200);
      expect(response.body.state.status).toBe("waiting");
      expect(response.body.state.session).toEqual(waiting.state.session);
      expect(response.body.state.harness?.questions?.at(-1)).toEqual(question);
    }
    const reopened = await meshJsonRequest<ChatSnapshot>(node, `/api/chats/${id}/snapshot`);
    expect(reopened.body.state.harness?.questions?.at(-1)).toEqual(question);
    const path = `/api/chats/${id}/questions/${question.requestId}`;
    const answer = { answers: [["Blue"]] };
    const [answerResponse, concurrentReconnect] = await Promise.all([
      meshJsonRequest(node, path, { body: answer }),
      meshJsonRequest<Chat>(node, `/api/chats/${id}/reconnect`, { body: {} }),
    ]);
    expect(answerResponse.status).toBe(200);
    expect(concurrentReconnect.status).toBe(200);
    const settled = await pollUntil(async () => (await meshJsonRequest<ChatSnapshot>(node, `/api/chats/${id}/snapshot`)).body,
      (snapshot) => snapshot.state.status === "idle" && snapshot.state.harness?.questions?.at(-1)?.status === "answered"
        && snapshot.transcript.messages.some((message) => message.role === "assistant" && message.content.includes("Blue")),
      { description: "original Copilot callback delivers its answer", timeoutMs: 10_000 });
    expect(settled.state.session).toEqual(waiting.state.session);
    const dialogue = settled.transcript.messages.filter((message) => message.question?.requestId === question.requestId);
    expect(dialogue).toMatchObject([
      { role: "assistant", content: "Choose a color", question: { scope: { kind: "unknown" }, status: "answered" } },
      { role: "user", content: "Blue", question: { status: "answered" } },
    ]);
    const context = settled.transcript.messages.find((message) => message.content === "I need your input.")!;
    const continuation = settled.transcript.messages.find((message) => message.content === "Consumed answer: Blue")!;
    expect(context.timestamp <= dialogue[0]!.timestamp).toBe(true);
    expect(dialogue[1]!.timestamp < continuation.timestamp).toBe(true);
    for (const extension of ["md", "html"]) {
      const exported = (await meshJsonRequest<string>(node, `/api/chats/${id}/transcript.${extension}`, { responseType: "text" })).body;
      expect(exported.indexOf("Choose a color") < exported.indexOf("Consumed answer: Blue")).toBe(true);
      expect(exported.indexOf("Blue", exported.indexOf("Choose a color")) < exported.indexOf("Consumed answer: Blue")).toBe(true);
    }
    expect(await Bun.file(join(node.dataDir, `copilot-answer-${waiting.state.session!.id}.json`)).json())
      .toEqual({ answer: "Blue", wasFreeform: false });
    expect((await meshJsonRequest(node, path, { body: answer })).status).toBe(200);
    expect((await meshJsonRequest(node, path, { body: { answers: [["Red"]] } })).status).toBe(409);

    const stopping = await ask();
    const stopped = await meshJsonRequest<Chat>(node, `/api/chats/${stopping.config.id}/interrupt`, { body: {} });
    expect(stopped.status).toBe(200);
    expect(stopped.body.state.status).toBe("idle");
    expect(stopped.body.state.harness?.questions?.at(-1)?.status).toBe("cancelled");
    expect((await meshJsonRequest(node, `/api/chats/${stopping.config.id}/questions/${stopping.state.harness!.questions!.at(-1)!.requestId}`, { body: answer })).status).toBe(409);
    expect(await Bun.file(join(node.dataDir, `copilot-cancelled-${stopping.state.session!.id}.json`)).json()).toMatchObject({
      code: expect.any(Number),
    });
  } finally {
    if (controller) { controller.child.kill(); await controller.child.exited; await rm(controller.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

// Native async questions already contain an assistant message and answer via
// normal prompt admission. HTTP snapshots and the runtime's input effect prove
// one durable dialogue for immediate, queued and steered delivery, not helper
// delegation. Steering must preserve the answer's content and provenance.
test("Codex async question dialogue reuses native messages and queued answer admission", async () => {
  const binaryDir = await createRuntime();
  let node: ManagedMeshNode | undefined;
  try {
    node = await startNode("controller", binaryDir);
    const controller = node;
    const hosts = await meshJsonRequest<ExecutionHostDescriptor[]>(controller, "/api/execution-hosts");
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "Async question dialogue", directory: controller.dataDir, workspaceType: "directory",
      executionHost: hosts.body.find((host) => host.ref.kind === "local")!.ref,
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(workspace.status).toBe(201);
    for (const mode of ["immediate", "queued", "steered"]) {
      const queued = mode !== "immediate";
      const created = await meshJsonRequest<Chat>(controller, "/api/chats", { body: {
        name: "Async question", workspaceId: workspace.body.id, useWorktree: false,
        model: { providerID: "codex", modelID: "fixture-model", variant: "" },
      } });
      expect(created.status).toBe(201);
      const id = created.body.config.id;
      const read = async () => (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body;
      expect((await meshJsonRequest(controller, `/api/chats/${id}/messages`, { body: {
        message: queued ? "queued-segmented-async-question-fixture" : "segmented-async-question-fixture",
      } })).status).toBe(200);
      const pending = await pollUntil(read, (snapshot) => snapshot.state.harness?.questions?.at(-1)?.status === "pending"
        && snapshot.state.status === (queued ? "streaming" : "idle"),
      { description: "native async question remains answerable", timeoutMs: 10_000, formatLastObserved: (snapshot) => JSON.stringify(snapshot) });
      const question = pending.state.harness!.questions!.at(-1)!;
      expect(pending.transcript.messages.filter((message) => message.role === "assistant"))
        .toMatchObject([
          { content: "Strategy context" },
          { content: "Choose a strategy", question: { requestId: question.requestId } },
        ]);
      expect(pending.transcript.messages.find((message) => message.content === "Strategy context")!.question).toBeUndefined();
      expect(question.scope.native?.messageId).not.toBe(question.transcript?.questionMessageId);
      const answer = { answers: [["Merge"]] };
      const path = `/api/chats/${id}/questions/${encodeURIComponent(question.requestId)}`;
      expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(200);
      if (queued) {
        const enqueued = await read();
        expect(enqueued.state.harness?.questions?.at(-1)).toMatchObject({ status: "queued" });
        expect(enqueued.transcript.messages.find((message) => message.role === "user" && message.question))
          .toMatchObject({ question: { status: "queued" } });
        const queue = enqueued.state.queuedMessages!;
        expect(queue).toHaveLength(1);
        const deliveryPath = mode === "steered"
          ? `queued-messages/${queue[0]!.id}/steer` : "interrupt";
        expect((await meshJsonRequest(controller, `/api/chats/${id}/${deliveryPath}`, { body: {} })).status).toBe(200);
      }
      await pollUntil(read, (snapshot) => snapshot.state.status === "idle"
        && snapshot.transcript.messages.some((message) => message.content === "Async answer consumed"),
      { description: "async answer reaches the original native conversation", timeoutMs: 10_000, formatLastObserved: (value) => JSON.stringify(value) });
      if (mode === "steered") {
        const admitted = await read();
        expect(admitted.state.harness?.questions?.at(-1)?.status).toBe("unconfirmed");
        const inputId = question.transcript!.answerMessageId;
        expect((await meshJsonRequest(controller, `/api/chats/${id}/queued-messages/${inputId}/reconcile`, { body: {} })).body)
          .toMatchObject({ admission: { status: "delivered", inputId } });
      }
      const settled = await read();
      expect(settled.transcript.messages.filter((message) => message.role === "user"))
        .toMatchObject([{ content: queued ? "queued-segmented-async-question-fixture" : "segmented-async-question-fixture" }, { content: "Merge" }]);
      const dialogue = settled.transcript.messages.filter((message) => message.question?.requestId === question.requestId);
      expect(dialogue).toMatchObject([{ role: "assistant" }, { role: "user", question: { status: "answered" } }]);
      expect((await meshJsonRequest(controller, path, { body: answer })).status).toBe(200);
      const reopened = await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`);
      expect(reopened.body.transcript.messages.filter((message) => message.question?.requestId === question.requestId)).toEqual(dialogue);
      expect(await Bun.file(join(controller.dataDir, `async-input-${settled.state.session!.id}.json`)).json())
        .toMatchObject([[{ type: "text", text: "Choose a strategy\nMerge" }]]);
    }
  } finally {
    if (node) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

// Queue admission is not native delivery. HTTP state, deletion and exports must
// retain an unsent answer and permit a replacement without sending the old input.
test("Codex queued question answers remain unsent until dispatch and removal permits retry", async () => {
  const binaryDir = await createRuntime();
  let node: ManagedMeshNode | undefined;
  try {
    node = await startNode("controller", binaryDir);
    const hosts = await meshJsonRequest<ExecutionHostDescriptor[]>(node, "/api/execution-hosts");
    const workspace = await meshJsonRequest<{ id: string }>(node, "/api/workspaces", { body: {
      name: "Queued question delivery", directory: node.dataDir, workspaceType: "directory",
      executionHost: hosts.body.find((host) => host.ref.kind === "local")!.ref,
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    const created = await meshJsonRequest<Chat>(node, "/api/chats", { body: {
      workspaceId: workspace.body.id, useWorktree: false,
      model: { providerID: "codex", modelID: "fixture-model", variant: "" },
    } });
    const id = created.body.config.id;
    const controller = node;
    const read = async () => (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body;
    await meshJsonRequest(node, `/api/chats/${id}/messages`, { body: { message: "queued-async-question-fixture" } });
    const pending = await pollUntil(read, (snapshot) => snapshot.state.harness?.questions?.at(-1)?.status === "pending",
      { description: "queued native question", timeoutMs: 10_000 });
    const request = pending.state.harness!.questions!.at(-1)!;
    const path = `/api/chats/${id}/questions/${encodeURIComponent(request.requestId)}`;
    expect((await meshJsonRequest(node, path, { body: { answers: [["Merge"]] } })).status).toBe(200);
    const queued = await read();
    expect(queued.state.harness?.questions?.at(-1)).toMatchObject({ status: "queued" });
    expect(queued.transcript.messages.filter((message) => message.question?.requestId === request.requestId))
      .toMatchObject([{ role: "assistant", question: { status: "queued" } }, { role: "user", content: "Merge", question: { status: "queued" } }]);
    expect((await meshJsonRequest(node, path, { body: { answers: [["Merge"]] } })).status).toBe(200);
    const inputId = request.transcript!.answerMessageId;
    expect((await read()).state.queuedMessages).toHaveLength(1);
    await Bun.write(join(node.dataDir, ".fixture-steer-reject"), "");
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}/steer`, { body: {} })).body)
      .toMatchObject({ admission: { status: "rejected", code: "turn-changed", inputId } });
    expect((await read()).state.harness?.questions?.at(-1)?.status).toBe("queued");
    expect((await meshJsonRequest(node, path, { body: { answers: [["Merge"]] } })).status).toBe(200);
    expect((await read()).state.queuedMessages).toHaveLength(1);
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}`, { method: "DELETE" })).status).toBe(200);
    const removed = await read();
    expect(removed.state.harness?.questions?.at(-1)?.status).toBe("pending");
    expect(removed.transcript.messages.find((message) => message.id === inputId)).toMatchObject({
      content: "Merge", question: { status: "pending" },
    });
    expect((await meshJsonRequest(node, path, { body: { answers: [["Rebase"]] } })).status).toBe(200);
    await meshJsonRequest(node, `/api/chats/${id}/interrupt`, { body: {} });
    const settled = await pollUntil(read, (snapshot) => snapshot.state.status === "idle"
      && snapshot.transcript.messages.some((message) => message.content === "Async answer consumed"),
    { description: "only replacement answer dispatched", timeoutMs: 10_000 });
    expect(settled.state.harness?.questions?.at(-1)?.status).toBe("answered");
    expect(settled.transcript.messages.filter((message) => message.role === "user" && message.question))
      .toMatchObject([{ id: inputId, content: "Rebase", question: { status: "answered" } }]);
    expect(await Bun.file(join(node.dataDir, `async-input-${settled.state.session!.id}.json`)).json())
      .toMatchObject([[{ type: "text", text: "Choose a strategy\nRebase" }]]);
  } finally {
    if (node) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

// The native seam records irreversible admission before losing its reply.
// Persisted HTTP uncertainty must prohibit removal/resend; a native-history
// receipt, not enqueue or RPC acceptance, may confirm the original answer.
test("Codex question answer admission loss stays unconfirmed until native reconciliation", async () => {
  const binaryDir = await createRuntime();
  let node: ManagedMeshNode | undefined;
  try {
    node = await startNode("controller", binaryDir);
    const hosts = await meshJsonRequest<ExecutionHostDescriptor[]>(node, "/api/execution-hosts");
    const workspace = await meshJsonRequest<{ id: string }>(node, "/api/workspaces", { body: {
      name: "Unconfirmed async delivery", directory: node.dataDir, workspaceType: "directory",
      executionHost: hosts.body.find((host) => host.ref.kind === "local")!.ref,
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    const created = await meshJsonRequest<Chat>(node, "/api/chats", { body: {
      workspaceId: workspace.body.id, useWorktree: false,
      model: { providerID: "codex", modelID: "fixture-model", variant: "" },
    } });
    const id = created.body.config.id;
    const controller = node;
    const read = async () => (await meshJsonRequest<ChatSnapshot>(controller, `/api/chats/${id}/snapshot?full=1`)).body;
    await meshJsonRequest(node, `/api/chats/${id}/messages`, { body: { message: "queued-async-question-fixture" } });
    const pending = await pollUntil(read, (snapshot) => snapshot.state.harness?.questions?.at(-1)?.status === "pending",
      { description: "uncertain-delivery native question", timeoutMs: 10_000 });
    const request = pending.state.harness!.questions!.at(-1)!;
    const path = `/api/chats/${id}/questions/${encodeURIComponent(request.requestId)}`;
    const answer = { answers: [["Merge"]] };
    await meshJsonRequest(node, path, { body: answer });
    const inputId = request.transcript!.answerMessageId;
    await Bun.write(join(node.dataDir, ".fixture-steer-response-loss"), "");
    await Bun.write(join(node.dataDir, ".fixture-steer-recovery-hidden"), "");
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}/steer`, { body: {} })).body)
      .toMatchObject({ admission: { status: "unknown", inputId } });
    const uncertain = await read();
    expect(uncertain.state.harness?.questions?.at(-1)?.status).toBe("unconfirmed");
    expect(uncertain.transcript.messages.find((message) => message.id === inputId))
      .toMatchObject({ content: "Merge", question: { status: "unconfirmed" } });
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}`, { method: "DELETE" })).status).toBe(409);
    expect((await meshJsonRequest(node, path, { body: answer })).status).toBe(409);
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}/reconcile`, { body: {} })).body)
      .toMatchObject({ admission: { status: "unknown" } });
    await unlink(join(node.dataDir, ".fixture-steer-recovery-hidden"));
    expect((await meshJsonRequest(node, `/api/chats/${id}/queued-messages/${inputId}/reconcile`, { body: {} })).body)
      .toMatchObject({ admission: { status: "delivered", inputId } });
    const delivered = await read();
    expect(delivered.state.harness?.questions?.at(-1)?.status).toBe("answered");
    expect(delivered.transcript.messages.find((message) => message.id === inputId))
      .toMatchObject({ content: "Merge", question: { status: "answered" } });
    expect((await meshJsonRequest(node, path, { body: answer })).status).toBe(200);
    expect(await Bun.file(join(node.dataDir, `async-input-${delivered.state.session!.id}.json`)).json())
      .toMatchObject([[{ type: "text", text: "Choose a strategy\nMerge" }]]);
  } finally {
    if (node) { node.child.kill(); await node.child.exited; await rm(node.dataDir, { recursive: true, force: true }); }
    await rm(binaryDir, { recursive: true, force: true });
  }
}, 30_000);

async function createRuntime(adapter: "codex" | "opencode2" | "copilot" = "codex"): Promise<string> {
  await mkdir(root, { recursive: true });
  const binaryDir = await mkdtemp(join(root, "runtime-"));
  const executable = join(binaryDir, adapter);
  const fixture = adapter === "codex" ? "native-mesh-codex.ts"
    : adapter === "copilot" ? "copilot-question-runtime.ts" : "opencode-question-runtime.ts";
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
test("Mesh native catalog, lifetime activity, steering and scoped Stop preserve the principal and owned host effects", async () => {
  const binaryDir = await createRuntime();
  const nodes: ManagedMeshNode[] = [];
  try {
    const controller = await startNode("controller", binaryDir); nodes.push(controller);
    const worker = await startNode("worker", binaryDir); nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const status = await meshJsonRequest<{ workers: Array<{ workerNodeId: string; workerNegotiatedProtocolVersion: number }> }>(controller, "/api/mesh/status");
    expect(status.body.workers[0]!.workerNegotiatedProtocolVersion).toBe(MESH_PROTOCOL_VERSION);
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
test("Mesh native harness executes and observes owned descendants through a real relay", async () => {
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
    expect(registered).toMatchObject({ workerNegotiatedProtocolVersion: MESH_PROTOCOL_VERSION, route: { kind: "relay" } });
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
