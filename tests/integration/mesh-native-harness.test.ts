import { expect, test } from "bun:test";
import { mkdir, mkdtemp, chmod, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { availablePort, meshJsonRequest, enrollMeshWorker, restartMeshNode, type ManagedMeshNode } from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";
import type { Chat } from "../../src/shared/chat";
import type { HarnessActivitySnapshot } from "../../src/shared/harness-control";
import { createNativeMeshPeer } from "../helpers/mesh-native-peer";
import type { AgentSession } from "../../src/backends/types";

const root = resolve(".cache/mesh-native-tests");

async function createRuntime(): Promise<string> {
  await mkdir(root, { recursive: true });
  const binaryDir = await mkdtemp(join(root, "runtime-"));
  const executable = join(binaryDir, "codex");
  await Bun.write(executable, `#!/bin/sh\nexec "${process.execPath}" "${resolve("tests/fixtures/native-mesh-codex.ts")}" "$@"\n`);
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
    const git = Bun.spawnSync(["git", "-C", worker.dataDir, "init"], { stdout: "ignore", stderr: "pipe" });
    expect(git.exitCode).toBe(0);
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", { body: {
      name: "native Mesh", directory: `${worker.dataDir}/`,
      executionHost: { kind: "mesh", nodeId: workerId },
      serverSettings: { agent: { adapter: "codex", provider: "codex" } },
    } });
    expect(workspace.status).toBe(201);
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
    await pollUntil(activity, (snapshot) => snapshot.observation === "available", { description: "authoritative native inventory recovers", timeoutMs: 5_000 });

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
