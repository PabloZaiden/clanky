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
import { installExternalAcpProvider, installExternalCode } from "./support/provider";
import { exerciseCodePreview, exerciseServicePreview } from "./support/code-preview";

interface Workspace { id: string; name: string; directory: string; access?: "read" | "work"; scratchpad: string }
interface Connection { connection: { id: string; status: string }; realtime: string; errorCode: string | null }
interface Terminal { config: { id: string } }
interface Frame { type?: string; data?: string; event?: { resource?: string; id?: string } }
interface Model { providerID: string; modelID: string; connected: boolean }
interface Work {
  config: { id: string; name: string; creator?: { kind: string; name: string } };
  state: { status: string; error?: unknown };
}
interface Snapshot {
  transcript: { messages: Array<{ role: string; content: string; attachments?: Array<{ filename: string; data: string }> }> };
}

async function json<T>(node: ManagedMeshNode, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await meshJsonRequest<T>(node, path, { method, ...(body === undefined ? {} : { body }) });
  if (response.status >= 400) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function createWorkspace(node: ManagedMeshNode, directory: string, name: string): Promise<Workspace> {
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
    serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
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
    const application: Bun.Server<undefined> = Bun.serve<undefined>({
      hostname: "127.0.0.1", port: 0,
      fetch(request: Request) {
        if (request.headers.get("upgrade") === "websocket") {
          return application.upgrade(request) ? undefined : new Response("Upgrade failed", { status: 400 });
        }
        return new Response("Shared workspace application");
      },
      websocket: { message(socket, data) { socket.send(data); } },
    });
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
