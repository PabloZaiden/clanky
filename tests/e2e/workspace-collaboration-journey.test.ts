import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand, startMeshNode, startMeshRelay, stopMeshNode, meshJsonRequest,
  meshNodeDiagnostics, restartMeshNode, type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { subscribeRealtime } from "./support/realtime";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import { installExternalAcpProvider, installExternalCode, installExternalNativeCopilotProvider } from "./support/provider";
import { exerciseCodePreview, exerciseServicePreview } from "./support/code-preview";

interface Workspace { id: string; name: string; directory: string; access?: "read" | "work" | "admin"; scratchpad: string }
interface Connection { connection: { id: string; status: string }; realtime: string; errorCode: string | null }
interface Terminal { config: { id: string } }
interface Frame { type?: string; data?: string; event?: { resource?: string; id?: string; type?: string; subagentId?: string } }
interface Model { providerID: string; modelID: string; connected: boolean }
interface Work {
  config: { id: string; name: string; creator?: { kind: string; name: string } };
  state: { status: string; error?: unknown; planMode?: { isPlanReady: boolean } };
}
interface Snapshot {
  transcript: { messages: Array<{ role: string; content: string; attachments?: Array<{ filename: string; data: string }> }> };
}

function previewApplication(content: string): Bun.Server<undefined> {
  const application: Bun.Server<undefined> = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(request: Request) {
      if (request.headers.get("upgrade") === "websocket") {
        return application.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      return new Response(content);
    },
    websocket: { message(socket, data) { socket.send(data); } },
  });
  return application;
}

async function json<T>(node: ManagedMeshNode, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await meshJsonRequest<T>(node, path, { method, ...(body === undefined ? {} : { body }) });
  if (response.status >= 400) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function createWorkspace(node: ManagedMeshNode, directory: string, name: string, adapter = "acp"): Promise<Workspace> {
  await mkdir(directory);
  const git = Bun.spawnSync(["git", "-C", directory, "init", "--quiet"]);
  if (git.exitCode) throw new Error(git.stderr.toString());
  for (const args of [
    ["config", "user.name", "Collaboration fixture"],
    ["config", "user.email", "collaboration@example.invalid"],
    ["commit", "--quiet", "--allow-empty", "-m", "Initialize shared work"],
  ]) {
    const result = Bun.spawnSync(["git", "-C", directory, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  const hosts = await json<Array<{ ref: { kind: string; nodeId?: string } }>>(node, "/api/execution-hosts");
  const host = hosts.find((entry) => entry.ref.kind === "local");
  if (!host) throw new Error("Local execution host unavailable");
  return await json(node, "/api/workspaces", "POST", {
    name, directory, executionHost: host.ref, workspaceType: "git", allowWorktrees: false,
    serverSettings: { agent: { adapter, provider: "copilot" } },
  });
}

async function cli(node: ManagedMeshNode, apiKey: string, args: string[]) {
  const child = Bun.spawn([...node.command, ...args], {
    env: {
      ...process.env, ...node.environment,
      CLANKY_BASE_URL: node.baseUrl, CLANKY_API_KEY: apiKey,
    },
    stdout: "pipe", stderr: "pipe", timeout: MESH_OPERATION_TIMEOUT_MS,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForWork(node: ManagedMeshNode, path: string, status: string): Promise<Work> {
  return await pollUntil(() => json<Work>(node, path), (work) => {
    if (work.state.status === "failed") throw new Error(`Shared work failed: ${JSON.stringify(work)}`);
    return work.state.status === status;
  }, { description: `${path} to become ${status}`, timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify });
}

function observeSocket(node: ManagedMeshNode, path: string, apiKey: string): { socket: WebSocket; frames: Frame[] } {
  const url = new URL(path, node.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const AuthenticatedWebSocket = WebSocket as typeof WebSocket & {
    new(url: URL, options: Bun.WebSocketOptions): WebSocket;
  };
  const socket = new AuthenticatedWebSocket(url, { headers: { authorization: `Bearer ${apiKey}`, origin: node.baseUrl } });
  const frames: Frame[] = [];
  socket.addEventListener("message", (message) => {
    frames.push(JSON.parse(String(message.data)) as Frame);
    if (frames.length > 128) frames.shift();
  });
  return { socket, frames };
}

test("a direct invitation file shares workspace work and streams without a relay and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-direct-collaboration-e2e-"));
  const nodes: ManagedMeshNode[] = [];
  const sockets: WebSocket[] = [];
  let failure: unknown;
  try {
    const command = await compiledClankyCommand();
    const bin = join(directory, "bin");
    await installExternalCode(bin);
    await installExternalNativeCopilotProvider(bin);
    for (const name of ["owner", "invitee"]) {
      const home = join(directory, name);
      await mkdir(home);
      nodes.push(await startMeshNode({
        role: "controller", command,
        environment: { HOME: home, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, CLANKY_LOG_LEVEL: "info" },
      }));
    }
    const owner = nodes[0]!, invitee = nodes[1]!;
    const workspace = await createWorkspace(owner, join(directory, "project"), "Direct shared project", "copilot");
    const created = await json<{ token: string }>(owner, "/api/collaboration/invitations", "POST", {
      transport: "direct", workspaceIds: [workspace.id],
    });
    const invitationPath = join(directory, "project.clanky-invite.json");
    await Bun.write(invitationPath, JSON.stringify({
      format: "clanky-workspace-invitation", version: 1, invitation: created.token,
    }));
    const invitation: { invitation: string } = await Bun.file(invitationPath).json();
    const connection = await json<{ id: string }>(invitee, "/api/collaboration/connections", "POST", {
      invitation: invitation.invitation,
    });
    const ready = async () => await pollUntil(() => json<Connection[]>(invitee, "/api/collaboration/connections"),
      (entries) => entries.some((entry) => entry.connection.id === connection.id && entry.realtime === "connected" && !entry.errorCode),
      { description: "direct collaboration realtime to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify });
    await ready();
    const shared = (await json<Workspace[]>(invitee, "/api/workspaces")).find((entry) => entry.name === workspace.name)!;
    expect(shared.access).toBe("work");
    const key = await json<{ token: string }>(invitee, "/api/api-keys", "POST", { name: "direct-guest", scopes: ["*"] });
    const realtime = observeSocket(invitee, "/api/ws", key.token);
    sockets.push(realtime.socket);
    await pollUntil(() => realtime.socket.readyState, (state) => state === WebSocket.OPEN,
      { description: "direct guest local realtime to open", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await subscribeRealtime(realtime.socket, { kinds: ["state"], resources: ["workspaces"] });
    await json(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`, "PUT", { scratchpad: "Direct handoff" });
    expect((await json<Workspace>(owner, `/api/workspaces/${workspace.id}`)).scratchpad).toBe("Direct handoff");
    await pollUntil(() => realtime.frames,
      (frames) => frames.some((frame) => frame.event?.resource === "workspaces" && frame.event.id === shared.id),
      { description: "direct workspace publication", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const uploadPath = join(directory, "handoff.txt"), downloadPath = join(directory, "received.txt");
    await Bun.write(uploadPath, "Direct file handoff\n");
    const upload = await cli(invitee, key.token, ["workspace", "upload", shared.id, uploadPath, "--remote-path", "handoff.txt", "--force"]);
    if (upload.exitCode) throw new Error(`Direct upload failed: ${upload.stderr}`);
    const download = await cli(invitee, key.token, ["workspace", "download", shared.id, "handoff.txt", "--output", downloadPath, "--force"]);
    if (download.exitCode) throw new Error(`Direct download failed: ${download.stderr}`);
    expect(await Bun.file(downloadPath).text()).toBe("Direct file handoff\n");
    await exerciseCodePreview({
      baseUrl: invitee.baseUrl, apiKey: key.token, workspace: workspace.name,
      workspaceId: shared.id, homeDirectory: invitee.environment["HOME"]!, logsDirectory: directory,
      expectedDirectory: workspace.directory, timeoutMs: MESH_OPERATION_TIMEOUT_MS,
    });
    const application = previewApplication("Direct shared application");
    try {
      await exerciseServicePreview({
        baseUrl: invitee.baseUrl, apiKey: key.token, workspace: workspace.name,
        workspaceId: shared.id, homeDirectory: invitee.environment["HOME"]!, logsDirectory: directory,
        port: application.port!, expectedContent: "Direct shared application",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      });
    } finally {
      await application.stop(true);
    }
    const terminal = await json<Terminal>(invitee, "/api/terminal-sessions", "POST", {
      workspaceId: shared.id, name: "Direct shell", connectionMode: "direct", useTmux: false,
    });
    const shell = observeSocket(invitee, `/api/terminal?terminalSessionId=${encodeURIComponent(terminal.config.id)}`, key.token);
    sockets.push(shell.socket);
    await pollUntil(() => shell.frames, (frames) => frames.some((frame) => frame.type === "terminal.connected"),
      { description: "direct shared terminal to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    shell.socket.send(JSON.stringify({ type: "terminal.input", data: "echo DIRECT_WORKSPACE_READY\r" }));
    await pollUntil(() => shell.frames,
      (frames) => frames.some((frame) => frame.type === "terminal.output" && frame.data?.includes("DIRECT_WORKSPACE_READY")),
      { description: "direct shared terminal output", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const grants = await json<Array<{ id: string }>>(owner, "/api/collaboration/guests");
    const grant = grants[0]!;
    const model = (await json<Model[]>(owner, `/api/models?workspaceId=${workspace.id}`)).find((entry) => entry.connected)!;
    const parent = await json<Work>(owner, "/api/chats", "POST", {
      name: "Shared native inventory", workspaceId: workspace.id, useWorktree: false,
      model: { providerID: model.providerID, modelID: model.modelID, variant: "" },
    });
    const resultPath = join(workspace.directory, "shared-inventory.txt"), releasePath = join(workspace.directory, "shared-inventory-ready.txt");
    await json(owner, `/api/chats/${parent.config.id}/messages`, "POST", {
      message: `Delegate the inventory. [background-result:${resultPath}] [continuation-release:${releasePath}]`,
    });
    const sharedParent = await pollUntil(async () => (await json<Work[]>(invitee, `/api/chats?workspaceId=${encodeURIComponent(shared.id)}`))
      .find((entry) => entry.config.name === "Shared native inventory"), (entry) => Boolean(entry),
      { description: "shared native conversation to appear", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    type ChildList = { items: Array<{ id: string; activity: { id: string; description: string } }> };
    const childListPath = `/api/chats/${encodeURIComponent(sharedParent!.config.id)}/subagents`;
    const sharedChild = await pollUntil(async () => (await json<ChildList>(invitee, childListPath)).items
      .find((entry) => entry.activity.description === "Workspace inventory"), (entry) => Boolean(entry),
      { description: "origin-qualified shared subagent to appear", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect(sharedChild!.id.startsWith("clanky.remote.v1.")).toBe(true);
    const childPath = `${childListPath}/${encodeURIComponent(sharedChild!.id)}`;
    await json(owner, `/api/collaboration/guests/${grant.id}/workspaces/${workspace.id}`, "PUT", { permission: "read" });
    await pollUntil(() => shell.socket.readyState, (state) => state === WebSocket.CLOSED,
      { description: "direct shell to close after permission reduction", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await ready();
    expect((await json<Workspace>(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`)).access).toBe("read");
    expect((await meshJsonRequest(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`, {
      method: "PUT", body: { scratchpad: "Not allowed" },
    })).status).toBe(403);
    const childRealtime = observeSocket(invitee, "/api/ws", key.token);
    sockets.push(childRealtime.socket);
    await pollUntil(() => childRealtime.socket.readyState, (state) => state === WebSocket.OPEN,
      { description: "read-only child realtime to open", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await subscribeRealtime(childRealtime.socket, {
      kinds: ["content"], types: ["subagent.transcript"], targets: { subagentId: sharedChild!.id },
    });
    const report = "The shared inventory is ready for read-only review.";
    await Bun.write(resultPath, report);
    await Bun.write(releasePath, "Continue.");
    const childSnapshot = await pollUntil(() => json<Snapshot>(invitee, `${childPath}/snapshot?full=1`),
      (snapshot) => snapshot.transcript.messages.some((message) => message.content === `Subagent findings: ${report}`),
      { description: "read-only collaborator to read saved child content", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await pollUntil(() => childRealtime.frames, (frames) => frames.some((frame) => frame.event?.type === "subagent.transcript"
      && frame.event.subagentId === sharedChild!.id),
      { description: "read-only collaborator to receive scoped child content", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect((await meshJsonRequest(invitee, `/api/chats/${encodeURIComponent(sharedParent!.config.id)}/activity/${sharedChild!.activity.id}/stop`, {
      method: "POST",
    })).status).toBe(403);
    for (const args of [
      ["add", "--", "handoff.txt", "shared-inventory-ready.txt", "shared-inventory.txt"],
      ["commit", "--quiet", "-m", "Record the reviewed shared inventory"],
    ]) {
      const result = Bun.spawnSync(["git", "-C", workspace.directory, ...args]);
      if (result.exitCode) throw new Error(result.stderr.toString());
    }
    const taskResult = join(workspace.directory, "task-inventory.txt"), taskRelease = join(workspace.directory, "task-inventory-ready.txt");
    const branches = await json<{ currentBranch: string }>(owner,
      `/api/git/branches?workspaceId=${workspace.id}&directory=${encodeURIComponent(workspace.directory)}`);
    const task = await json<Work>(owner, "/api/tasks", "POST", {
      workspaceId: workspace.id, name: "Delegated task inventory",
      prompt: `Plan the implementation using a delegated inventory. [background-result:${taskResult}] [continuation-release:${taskRelease}]`,
      baseBranch: branches.currentBranch, attachments: [],
      model: { providerID: model.providerID, modelID: model.modelID, variant: "" }, cheapModel: { mode: "same-as-task" },
      maxIterations: 2, maxConsecutiveErrors: 2, activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>", git: { branchPrefix: "collaboration/", commitScope: "" },
      useWorktree: false, clearPlanningFolder: true, autoAcceptPlan: false, fullyAutonomous: false, draft: false,
    });
    const taskChild = await pollUntil(async () => (await json<ChildList>(owner, `/api/tasks/${task.config.id}/subagents`)).items
      .find((entry) => entry.activity.description === "Workspace inventory"), (entry) => Boolean(entry),
      { description: "task execution to retain its own delegated conversation", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const taskChildPath = `/api/tasks/${task.config.id}/subagents/${taskChild!.id}/snapshot?full=1`;
    const liveTaskChild = await json<Snapshot>(owner, taskChildPath);
    expect(liveTaskChild.transcript.messages.some((message) => message.role === "user"
      && message.content === "Inspect the reusable modules and report the inventory.")).toBe(true);
    await Bun.write(taskResult, "Task-specific inventory.");
    await Bun.write(taskRelease, "Finish planning.");
    await pollUntil(() => json<Snapshot>(owner, taskChildPath),
      (snapshot) => snapshot.transcript.messages.some((message) => message.content === "Subagent findings: Task-specific inventory."),
      { description: "task child to retain its independent completed result", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await pollUntil(() => json<Work>(owner, `/api/tasks/${task.config.id}`),
      (work) => work.state.planMode?.isPlanReady === true,
      { description: "delegated task plan to await user approval", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await restartMeshNode(owner);
    await ready();
    await restartMeshNode(invitee);
    await ready();
    expect((await json<Workspace>(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`)).scratchpad).toBe("Direct handoff");
    expect((await json<Workspace>(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`)).access).toBe("read");
    expect((await json<Snapshot>(invitee, `${childPath}/snapshot?full=1`)).transcript.messages).toEqual(childSnapshot.transcript.messages);
    expect((await json<Snapshot>(owner, taskChildPath)).transcript.messages.some((message) => message.content === "Subagent findings: Task-specific inventory.")).toBe(true);
    await json(owner, `/api/collaboration/guests/${grant.id}`, "DELETE");
    await pollUntil(async () => await meshJsonRequest(invitee, `/api/workspaces/${encodeURIComponent(shared.id)}`),
      (result) => result.status === 403 || result.status === 410 || result.status === 503,
      { description: "direct grant revocation to deny workspace access", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect([403, 410, 503]).toContain((await meshJsonRequest(invitee, `${childPath}/snapshot`)).status);
  } catch (error) {
    failure = error;
    for (const node of nodes) console.error(meshNodeDiagnostics(node));
  } finally {
    const cleanup: unknown[] = [];
    for (const socket of sockets) socket.close();
    const results = await Promise.allSettled(nodes.reverse().map((node) => stopMeshNode(node)));
    for (const result of results) if (result.status === "rejected") cleanup.push(result.reason);
    if (!cleanup.length) await rm(directory, { recursive: true, force: true });
    if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, "Direct collaboration cleanup failed", { cause: failure });
  }
  if (failure) throw failure;
}, 120_000);

test("collaborators review and work across granted workspaces while owners manage their access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-collaboration-e2e-"));
  const nodes: ManagedMeshNode[] = [];
  const sockets: WebSocket[] = [];
  let failure: unknown;
  try {
    const command = await compiledClankyCommand();
    const bin = join(directory, "bin");
    await installExternalAcpProvider(bin);
    await installExternalCode(bin);
    for (const name of ["controller", "guest"]) {
      const home = join(directory, name);
      await mkdir(home);
      nodes.push(await startMeshNode({
        role: "controller", command,
        environment: { HOME: home, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, CLANKY_LOG_LEVEL: "info" },
      }));
    }
    const controller = nodes[0]!, guest = nodes[1]!;
    const bootstrap = await json<{ controllerFingerprint: string }>(controller, "/api/mesh/relay");
    const relay = await startMeshRelay({ command, controllerFingerprint: bootstrap.controllerFingerprint });
    nodes.push(relay);
    await json(controller, "/api/mesh/relay", "POST", { name: "sharing", relayUrl: relay.baseUrl });
    await pollUntil(() => json<{ relays: Array<{ connected: boolean }> }>(controller, "/api/mesh/relay"),
      (value) => value.relays.some((entry) => entry.connected),
      { description: "the sharing controller relay to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const alpha = await createWorkspace(controller, join(directory, "alpha"), "Shared alpha");
    const beta = await createWorkspace(controller, join(directory, "beta"), "Shared beta");
    const review = await createWorkspace(controller, join(directory, "review"), "Shared review");
    await Bun.write(join(review.directory, "handoff.txt"), "Published review handoff\n");
    await json(controller, `/api/workspaces/${review.id}`, "PUT", { scratchpad: "Review the published handoff" });
    await createWorkspace(controller, join(directory, "private"), "Controller private");
    const local = await createWorkspace(guest, join(directory, "local"), "Guest local");
    const models = await json<Model[]>(controller, `/api/models?workspaceId=${beta.id}`);
    const selectedModel = models.find((entry) => entry.connected);
    if (!selectedModel) throw new Error(`The external provider offers no model: ${JSON.stringify(models)}`);
    const model = { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: "" };
    await json<Work>(controller, "/api/chats", "POST", {
      workspaceId: beta.id, name: "Owner's existing conversation", model, useWorktree: false,
    });
    const invitation = await json<{ token: string }>(controller, "/api/collaboration/invitations", "POST", {
      workspaceIds: [alpha.id, beta.id, review.id],
      workspacePermissions: { [review.id]: "read" }, relayName: "sharing",
    });
    await json(guest, "/api/collaboration/connections", "POST", { invitation: invitation.token });
    await pollUntil(() => json<Connection[]>(guest, "/api/collaboration/connections"),
      (value) => value.some((entry) => entry.realtime === "connected" && !entry.errorCode),
      { description: "the paired realtime source to become ready", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const workspaces = await json<Workspace[]>(guest, "/api/workspaces");
    expect(workspaces.map((entry) => entry.name).sort()).toEqual(["Guest local", "Shared alpha", "Shared beta", "Shared review"]);
    expect(workspaces.find((entry) => entry.name === "Guest local")?.id).toBe(local.id);
    const sharedAlpha = workspaces.find((entry) => entry.name === alpha.name)!;
    const sharedBeta = workspaces.find((entry) => entry.name === beta.name)!;
    const sharedReview = workspaces.find((entry) => entry.name === review.name)!;
    expect(sharedReview.access).toBe("read");
    expect(sharedBeta.access).toBe("work");
    expect((await json<Workspace>(guest, `/api/workspaces/${encodeURIComponent(sharedReview.id)}`)).scratchpad)
      .toBe("Review the published handoff");
    const metadata = await json<{ entries: Array<{ name: string }> }>(guest,
      `/api/workspaces/${encodeURIComponent(sharedReview.id)}/files/filesystem`, "POST", {
        operation: "list", path: review.directory,
      });
    expect(metadata.entries.some((entry) => entry.name === "handoff.txt")).toBe(true);
    const deniedNotes = await meshJsonRequest(guest, `/api/workspaces/${encodeURIComponent(sharedReview.id)}`, {
      method: "PUT", body: { scratchpad: "Changed by observer" },
    });
    expect(deniedNotes.status).toBe(403);
    const deniedExecution = await meshJsonRequest(guest, `/api/workspaces/${encodeURIComponent(sharedReview.id)}/exec`, {
      method: "POST", body: { command: "git", args: ["status"], timeoutMs: 5_000 },
    });
    expect(deniedExecution.status).toBe(403);
    const deniedFile = await meshJsonRequest(guest, `/api/workspaces/${encodeURIComponent(sharedReview.id)}/files/filesystem`, {
      method: "POST", body: { operation: "delete", path: join(review.directory, "handoff.txt") },
    });
    expect(deniedFile.status).toBe(403);
    expect((await json<Workspace>(controller, `/api/workspaces/${review.id}`)).scratchpad).toBe("Review the published handoff");
    expect(await Bun.file(join(review.directory, "handoff.txt")).text()).toBe("Published review handoff\n");
    expect(sharedAlpha.id).toStartWith("clanky.remote.v1.");
    const execution = await json<{ stdout: string; exitCode: number }>(guest,
      `/api/workspaces/${encodeURIComponent(sharedAlpha.id)}/exec`, "POST", {
        command: process.execPath, args: ["-e", "console.log(process.env['HOME'])"], timeoutMs: 5_000,
      });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout.trim()).toBe(controller.environment["HOME"]!);
    const key = await json<{ token: string }>(guest, "/api/api-keys", "POST", { name: "collaboration-client", scopes: ["*"] });
    const reviewDownload = join(directory, "review-handoff.txt");
    const reviewTransfer = await cli(guest, key.token,
      ["workspace", "download", sharedReview.id, "handoff.txt", "--output", reviewDownload, "--force"]);
    if (reviewTransfer.exitCode) throw new Error(`Review download failed: ${reviewTransfer.stderr}`);
    expect(await Bun.file(reviewDownload).text()).toBe("Published review handoff\n");
    const sharedChats = await json<Work[]>(guest, `/api/chats?workspaceId=${encodeURIComponent(sharedBeta.id)}`);
    const existing = sharedChats.find((entry) => entry.config.name === "Owner's existing conversation");
    if (!existing) throw new Error("The collaborator cannot open existing workspace work.");
    expect(existing.config.creator?.kind).toBe("user");
    const specification = Buffer.from("Shared implementation notes\n");
    await json(guest, `/api/chats/${encodeURIComponent(existing.config.id)}/messages`, "POST", {
      message: "Continue the owner's shared planning conversation",
      attachments: [{
        id: crypto.randomUUID(), filename: "shared-specification.txt", mimeType: "text/plain",
        data: specification.toString("base64"), size: specification.byteLength,
      }],
    });
    await waitForWork(guest, `/api/chats/${encodeURIComponent(existing.config.id)}`, "idle");
    const sharedHistory = await json<Snapshot>(guest, `/api/chats/${encodeURIComponent(existing.config.id)}/snapshot?full=1`);
    expect(sharedHistory.transcript.messages.some((message) => message.attachments?.some((attachment) =>
      attachment.filename === "shared-specification.txt" && attachment.data === specification.toString("base64")))).toBe(true);
    await json(guest, "/api/preferences/quick-chat", "PUT", { workspaceId: sharedAlpha.id, model });
    const conversation = await json<Work>(guest, "/api/chats", "POST", {
      workspaceId: sharedAlpha.id, name: "Collaborative implementation", model, quick: true, useWorktree: false,
    });
    expect(conversation.config.creator?.kind).toBe("guest");
    const ownerChats = await json<Work[]>(controller, `/api/chats?workspaceId=${alpha.id}`);
    const ownerConversation = ownerChats.find((entry) => entry.config.name === conversation.config.name);
    if (!ownerConversation) throw new Error("The controller cannot see the collaborator's conversation.");
    expect(ownerConversation.config.creator).toEqual(conversation.config.creator);
    const uploadPath = join(directory, "handoff.txt");
    const downloadPath = join(directory, "received-handoff.txt");
    await Bun.write(uploadPath, "Shared implementation handoff\n");
    const upload = await cli(guest, key.token, ["workspace", "upload", sharedBeta.id, uploadPath, "--remote-path", "handoff.txt", "--force"]);
    if (upload.exitCode) throw new Error(`Shared CLI upload failed: ${upload.stderr}`);
    const download = await cli(guest, key.token, ["workspace", "download", sharedBeta.id, "handoff.txt", "--output", downloadPath, "--force"]);
    if (download.exitCode) throw new Error(`Shared CLI download failed: ${download.stderr}`);
    expect(await Bun.file(join(beta.directory, "handoff.txt")).text()).toBe("Shared implementation handoff\n");
    expect(await Bun.file(downloadPath).text()).toBe("Shared implementation handoff\n");
    const localConversation = await json<Work>(guest, "/api/chats", "POST", {
      workspaceId: local.id, name: "Local planning notes", model, useWorktree: false,
    });
    await json(guest, `/api/chats/${localConversation.config.id}`, "DELETE");
    await json(guest, `/api/chats/${encodeURIComponent(existing.config.id)}`, "DELETE");
    const retired: Array<{ id: string; name: string }> = [];
    let trashCursor: string | null = null;
    do {
      const page: { items: typeof retired; nextCursor: string | null } = await json(guest,
        `/api/trash?limit=1${trashCursor ? `&cursor=${encodeURIComponent(trashCursor)}` : ""}`);
      retired.push(...page.items);
      trashCursor = page.nextCursor;
      if (retired.length > 2) throw new Error(`Unexpected retired conversations: ${JSON.stringify(retired)}`);
    } while (trashCursor);
    expect(retired.map((entry) => entry.name).sort()).toEqual(["Local planning notes", "Owner's existing conversation"]);
    await json(guest, `/api/trash/${encodeURIComponent(existing.config.id)}/restore`, "POST");
    expect((await json<Work>(guest, `/api/chats/${encodeURIComponent(existing.config.id)}`)).state.status).toBe("idle");
    await exerciseCodePreview({
      baseUrl: guest.baseUrl, apiKey: key.token, workspace: beta.name, workspaceId: sharedBeta.id,
      homeDirectory: guest.environment["HOME"]!, logsDirectory: directory,
      selector: { chat: existing.config.name },
      expectedDirectory: beta.directory, timeoutMs: MESH_OPERATION_TIMEOUT_MS,
    });
    const application = previewApplication("Shared workspace application");
    try {
      await exerciseServicePreview({
        baseUrl: guest.baseUrl, apiKey: key.token, workspace: beta.name, workspaceId: sharedBeta.id,
        homeDirectory: guest.environment["HOME"]!, logsDirectory: directory,
        port: application.port!, expectedContent: "Shared workspace application",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      });
    } finally {
      await application.stop(true);
    }
    const realtime = observeSocket(guest, "/api/ws", key.token);
    sockets.push(realtime.socket);
    await pollUntil(() => realtime.socket.readyState, (value) => value === WebSocket.OPEN,
      { description: "the ordinary guest realtime websocket to open", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    await subscribeRealtime(realtime.socket, { kinds: ["state"], resources: ["workspaces"] });
    const guestTerminals: Array<{ terminal: Terminal; socket: WebSocket; frames: Frame[] }> = [];
    for (const workspace of [sharedAlpha, sharedBeta]) {
      const terminal = await json<Terminal>(guest, "/api/terminal-sessions", "POST", {
        workspaceId: workspace.id, name: `${workspace.name} shell`, connectionMode: "direct", useTmux: false,
      });
      const observed = observeSocket(guest, `/api/terminal?terminalSessionId=${encodeURIComponent(terminal.config.id)}`, key.token);
      sockets.push(observed.socket);
      await pollUntil(() => observed.frames,
        (frames) => frames.some((frame) => frame.type === "terminal.connected"), {
          description: `the ${workspace.name} shell to connect through the relay`,
          timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify,
        });
      guestTerminals.push({ terminal, ...observed });
    }
    await json(guest, `/api/workspaces/${encodeURIComponent(sharedAlpha.id)}`, "PUT", { scratchpad: "Shared planning notes" });
    const notes = await json<{ scratchpad: string }>(controller, `/api/workspaces/${alpha.id}`);
    expect(notes.scratchpad).toBe("Shared planning notes");
    await pollUntil(() => realtime.frames,
      (frames) => frames.some((frame) => frame.event?.resource === "workspaces" && frame.event.id === sharedAlpha.id), {
        description: "the ordinary local websocket to receive the shared workspace change",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify,
      });
    const forbidden = await meshJsonRequest(guest, `/api/workspaces/${encodeURIComponent(sharedAlpha.id)}`, {
      method: "PUT", body: { name: "Not an administrator" },
    });
    expect(forbidden.status).toBe(403);
    const ownerTerminal = await json<Terminal>(controller, "/api/terminal-sessions", "POST", {
      workspaceId: alpha.id, name: "Controller shell", connectionMode: "direct", useTmux: false,
    });
    const collaborators = await json<Array<{ id: string }>>(controller, "/api/collaboration/guests");
    const agent = await json<Work>(guest, "/api/agents", "POST", {
      workspaceId: sharedAlpha.id, name: "Shared recurring report", prompt: "Prepare the workspace report", model,
      useWorktree: false, enabled: true,
      schedule: {
        startAtLocal: new Date(Date.now() + 8_000).toISOString().slice(0, 19),
        timezone: "UTC", interval: { value: 1, unit: "minutes" },
      },
    });
    const ownerAgent = (await json<Work[]>(controller, "/api/agents"))
      .find((entry) => entry.config.name === agent.config.name);
    if (!ownerAgent) throw new Error("The shared agent was not admitted by the controller.");
    const branches = await json<{ currentBranch: string }>(guest,
      `/api/git/branches?workspaceId=${encodeURIComponent(sharedAlpha.id)}&directory=${encodeURIComponent(alpha.directory)}`);
    const task = await json<Work>(guest, "/api/tasks", "POST", {
      workspaceId: sharedAlpha.id, name: "Shared checklist", prompt: "[slow] Implement the shared checklist",
      baseBranch: branches.currentBranch,
      attachments: [], model, cheapModel: { mode: "same-as-task" },
      maxIterations: 2, maxConsecutiveErrors: 2, activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>", git: { branchPrefix: "collaboration/", commitScope: "" },
      useWorktree: false, clearPlanningFolder: true, autoAcceptPlan: true, fullyAutonomous: false, draft: false,
    });
    expect(task.config.creator?.kind).toBe("guest");
    const ownerTask = (await json<Work[]>(controller, "/api/tasks"))
      .find((entry) => entry.config.name === task.config.name);
    if (!ownerTask) throw new Error("The shared task was not admitted by the controller.");
    await json(guest, `/api/chats/${encodeURIComponent(conversation.config.id)}/messages`, "POST", {
      message: "[slow] Complete the shared handoff after the collaborator disconnects",
    });
    await json(controller, `/api/collaboration/guests/${collaborators[0]!.id}/workspaces/${alpha.id}`, "DELETE");
    await pollUntil(() => guestTerminals[0]!.socket.readyState, (value) => value === WebSocket.CLOSED,
      { description: "the retired guest shell to close", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect(guestTerminals[1]!.socket.readyState).toBe(WebSocket.OPEN);
    guestTerminals[1]!.socket.send(JSON.stringify({
      type: "terminal.input", data: "echo COLLABORATION_BETA_REMAINS\r",
    }));
    await pollUntil(() => guestTerminals[1]!.frames,
      (frames) => frames.some((frame) => frame.type === "terminal.output" && frame.data?.includes("COLLABORATION_BETA_REMAINS")), {
        description: "the remaining workspace shell to keep working",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify,
      });
    expect((await meshJsonRequest(guest, `/api/workspaces/${encodeURIComponent(sharedAlpha.id)}`)).status).toBe(403);
    expect((await json<Workspace>(guest, `/api/workspaces/${encodeURIComponent(sharedBeta.id)}`)).id).toBe(sharedBeta.id);
    expect((await json<Terminal>(controller, `/api/terminal-sessions/${ownerTerminal.config.id}`)).config.id).toBe(ownerTerminal.config.id);
    expect((await json<Workspace>(guest, `/api/workspaces/${local.id}`)).id).toBe(local.id);
    await waitForWork(controller, `/api/chats/${ownerConversation.config.id}`, "idle");
    const handoff = await json<Snapshot>(controller, `/api/chats/${ownerConversation.config.id}/snapshot?full=1`);
    expect(handoff.transcript.messages.some((entry) => entry.role === "assistant" && entry.content.trim().length > 0)).toBe(true);
    const completedTask = await waitForWork(controller, `/api/tasks/${ownerTask.config.id}`, "completed");
    expect(completedTask.config.creator).toEqual(task.config.creator);
    await pollUntil(() => json<Array<{ status: string; trigger: string }>>(controller, `/api/agents/${ownerAgent.config.id}/runs`),
      (runs) => runs.some((run) => run.status === "completed" && run.trigger === "schedule"), {
        description: "the controller to run its admitted shared schedule after guest retirement",
        timeoutMs: MESH_OPERATION_TIMEOUT_MS, formatLastObserved: JSON.stringify,
      });
    await json(controller, `/api/collaboration/guests/${collaborators[0]!.id}/workspaces/${beta.id}`, "PUT", { permission: "read" });
    await pollUntil(() => guestTerminals[1]!.socket.readyState, (value) => value === WebSocket.CLOSED,
      { description: "the workspace shell to close when work access ends", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect((await json<Workspace>(guest, `/api/workspaces/${encodeURIComponent(sharedBeta.id)}`)).access).toBe("read");
    expect((await json<Terminal>(controller, `/api/terminal-sessions/${ownerTerminal.config.id}`)).config.id).toBe(ownerTerminal.config.id);
    controller.child.kill();
    await controller.child.exited;
    await pollUntil(() => json<Connection[]>(guest, "/api/collaboration/connections"),
      (connections) => connections.every((entry) => entry.realtime === "disconnected" && entry.errorCode), {
        description: "the guest to observe its controller outage", timeoutMs: MESH_OPERATION_TIMEOUT_MS,
        formatLastObserved: JSON.stringify,
      });
    const partial = await fetch(new URL("/api/workspaces", guest.baseUrl), { signal: AbortSignal.timeout(MESH_OPERATION_TIMEOUT_MS) });
    expect(partial.headers.get("X-Clanky-Partial")).toBe("true");
    expect((await partial.json() as Workspace[]).map((entry) => entry.name)).toEqual([local.name]);
    const partialCli = await cli(guest, key.token, ["api", "workspaces", "--method", "GET"]);
    expect(partialCli.exitCode).not.toBe(0);
    expect(() => JSON.parse(partialCli.stdout)).not.toThrow();
    await restartMeshNode(controller);
    await restartMeshNode(guest);
    await pollUntil(() => json<Connection[]>(guest, "/api/collaboration/connections"),
      (connections) => connections.some((entry) => entry.realtime === "connected" && !entry.errorCode), {
        description: "the restarted guest to restore its authorized controller source", timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      });
    const reopened = await json<Work>(guest, `/api/chats/${encodeURIComponent(existing.config.id)}`);
    expect(reopened.config.creator?.kind).toBe("user");
    expect((await json<Workspace[]>(guest, "/api/workspaces")).map((entry) => entry.name).sort())
      .toEqual([local.name, beta.name, review.name].sort());
    expect((await json<Workspace>(guest, `/api/workspaces/${encodeURIComponent(sharedBeta.id)}`)).access).toBe("read");
    expect((await json<Workspace>(guest, `/api/workspaces/${encodeURIComponent(sharedReview.id)}`)).access).toBe("read");
    const deniedMessage = await meshJsonRequest(guest, `/api/chats/${encodeURIComponent(existing.config.id)}/messages`, {
      method: "POST", body: { message: "Continue the reviewed work" },
    });
    expect(deniedMessage.status).toBe(403);
    const restoredTask = await json<Work>(controller, `/api/tasks/${ownerTask.config.id}`);
    expect(restoredTask.config.creator).toEqual(task.config.creator);
  } catch (error) {
    failure = error;
    for (const node of nodes) console.error(meshNodeDiagnostics(node));
  } finally {
    const cleanup: unknown[] = [];
    const closed = await Promise.allSettled(sockets.map(async (socket) => {
      socket.close();
      await pollUntil(() => socket.readyState, (state) => state === WebSocket.CLOSED, {
        description: "the collaboration journey websocket to close", timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      });
    }));
    for (const result of closed) if (result.status === "rejected") cleanup.push(result.reason);
    const results = await Promise.allSettled(nodes.reverse().map(async (node) => await stopMeshNode(node)));
    for (const result of results) if (result.status === "rejected") cleanup.push(result.reason);
    if (!cleanup.length) await rm(directory, { recursive: true, force: true });
    if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, "Collaboration journey cleanup failed", { cause: failure });
  }
  if (failure) throw failure;
}, 120_000);

test("an invited collaborator works in all current and future workspaces while the owner retains workspace administration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-workspace-administration-e2e-"));
  const nodes: ManagedMeshNode[] = [];
  const sockets: WebSocket[] = [];
  let failure: unknown;
  try {
    const command = await compiledClankyCommand();
    const bin = join(directory, "bin");
    await installExternalAcpProvider(bin);
    for (const name of ["owner", "administrator"]) {
      const home = join(directory, name);
      await mkdir(home);
      nodes.push(await startMeshNode({
        role: "controller", command,
        environment: { HOME: home, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`, CLANKY_LOG_LEVEL: "info" },
      }));
    }
    const owner = nodes[0]!, administrator = nodes[1]!;
    const bootstrap = await json<{ controllerFingerprint: string }>(owner, "/api/mesh/relay");
    const relay = await startMeshRelay({ command, controllerFingerprint: bootstrap.controllerFingerprint });
    nodes.push(relay);
    await json(owner, "/api/mesh/relay", "POST", { name: "administration", relayUrl: relay.baseUrl });
    await pollUntil(() => json<{ relays: Array<{ connected: boolean }> }>(owner, "/api/mesh/relay"),
      (value) => value.relays.some((entry) => entry.connected),
      { description: "the workspace administration relay to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const existing = await createWorkspace(owner, join(directory, "existing"), "Existing workspace");
    const invitation = await json<{ token: string }>(owner, "/api/collaboration/invitations", "POST", {
      name: "All-workspaces collaborator", allWorkspacesAdmin: true, relayName: "administration",
    });
    await json(administrator, "/api/collaboration/connections", "POST", { invitation: invitation.token });
    await pollUntil(() => json<Connection[]>(administrator, "/api/collaboration/connections"),
      (value) => value.some((entry) => entry.realtime === "connected" && !entry.errorCode),
      { description: "the workspace administrator pairing to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const access = await json<Array<{ id: string; allWorkspacesAdmin: boolean }>>(administrator, "/api/collaboration/access");
    const controller = access.find((entry) => entry.allWorkspacesAdmin);
    if (!controller) throw new Error("All-workspaces access was not granted.");
    const shared = (await json<Workspace[]>(administrator, "/api/workspaces"))
      .find((workspace) => workspace.name === existing.name);
    if (!shared) throw new Error("The collaborator cannot discover the existing workspace.");
    expect(shared.access).toBe("work");
    expect((await meshJsonRequest(administrator, `/api/workspaces?controllerId=${encodeURIComponent(controller.id)}`, {
      method: "POST", body: {
        name: "Additional workspace", directory: existing.directory, executionHost: { kind: "local" },
        serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
      },
    })).status).toBe(403);
    expect((await meshJsonRequest(administrator, `/api/workspaces/${encodeURIComponent(shared.id)}`, {
      method: "PUT", body: { name: "Managed workspace", archived: true, allowClankyContext: true },
    })).status).toBe(403);
    expect((await meshJsonRequest(administrator, `/api/workspaces/${encodeURIComponent(shared.id)}`, {
      method: "DELETE",
    })).status).toBe(403);
    await json(administrator, `/api/workspaces/${encodeURIComponent(shared.id)}`, "PUT", { scratchpad: "Existing workspace handoff" });
    expect((await json<Workspace>(owner, `/api/workspaces/${existing.id}`)).scratchpad).toBe("Existing workspace handoff");
    const key = await json<{ token: string }>(administrator, "/api/api-keys", "POST", { name: "workspace-administration", scopes: ["*"] });
    const future = await createWorkspace(owner, join(directory, "future"), "Future workspace");
    const discovered = await pollUntil(() => json<Workspace[]>(administrator, "/api/workspaces"),
      (workspaces) => workspaces.some((workspace) => workspace.name === future.name),
      { description: "the administrator to discover the owner's new workspace", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const sharedFuture = discovered.find((workspace) => workspace.name === future.name)!;
    await json(administrator, `/api/workspaces/${encodeURIComponent(sharedFuture.id)}`, "PUT", { scratchpad: "New workspace handoff" });
    expect((await json<Workspace>(owner, `/api/workspaces/${future.id}`)).scratchpad).toBe("New workspace handoff");
    await restartMeshNode(owner);
    await restartMeshNode(administrator);
    await pollUntil(() => json<Connection[]>(administrator, "/api/collaboration/connections"),
      (value) => value.some((entry) => entry.realtime === "connected" && !entry.errorCode),
      { description: "workspace administration to recover after restart", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect((await json<Workspace>(administrator, `/api/workspaces/${encodeURIComponent(sharedFuture.id)}`)).access).toBe("work");
    const terminal = await json<Terminal>(administrator, "/api/terminal-sessions", "POST", {
      workspaceId: sharedFuture.id, name: "Workspace administrator shell", connectionMode: "direct", useTmux: false,
    });
    const observed = observeSocket(administrator, `/api/terminal?terminalSessionId=${encodeURIComponent(terminal.config.id)}`, key.token);
    sockets.push(observed.socket);
    await pollUntil(() => observed.frames, (frames) => frames.some((frame) => frame.type === "terminal.connected"),
      { description: "the administrator's workspace shell to connect", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    const guests = await json<Array<{ id: string; allWorkspacesAdmin: boolean }>>(owner, "/api/collaboration/guests");
    const guest = guests.find((entry) => entry.allWorkspacesAdmin);
    if (!guest) throw new Error("The owner cannot find the workspace administrator.");
    await json(owner, `/api/collaboration/guests/${guest.id}`, "DELETE");
    await pollUntil(() => observed.socket.readyState, (state) => state === WebSocket.CLOSED,
      { description: "revocation to close the administrator's workspace shell", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    expect((await meshJsonRequest(administrator, `/api/workspaces/${encodeURIComponent(sharedFuture.id)}`)).status)
      .toBeGreaterThanOrEqual(400);
    expect((await json<Workspace>(owner, `/api/workspaces/${future.id}`)).scratchpad).toBe("New workspace handoff");
  } catch (error) {
    failure = error;
    for (const node of nodes) console.error(meshNodeDiagnostics(node));
  } finally {
    const cleanup: unknown[] = [];
    const closed = await Promise.allSettled(sockets.map(async (socket) => {
      socket.close();
      await pollUntil(() => socket.readyState, (state) => state === WebSocket.CLOSED,
        { description: "the administration journey websocket to close", timeoutMs: MESH_OPERATION_TIMEOUT_MS });
    }));
    for (const result of closed) if (result.status === "rejected") cleanup.push(result.reason);
    const results = await Promise.allSettled(nodes.reverse().map(async (node) => await stopMeshNode(node)));
    for (const result of results) if (result.status === "rejected") cleanup.push(result.reason);
    if (!cleanup.length) await rm(directory, { recursive: true, force: true });
    if (cleanup.length) failure = new AggregateError(failure ? [failure, ...cleanup] : cleanup, "Workspace administration cleanup failed", { cause: failure });
  }
  if (failure) throw failure;
}, 120_000);
