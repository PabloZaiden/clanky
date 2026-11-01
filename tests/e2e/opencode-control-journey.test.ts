import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { E2EApplication } from "./support/application";
import { createFileAttachment, expectedFileInspection } from "./support/attachments";
import { pollUntil } from "./support/polling";
import { subscribeRealtime } from "./support/realtime";
import { installExternalNativeOpenCodeProvider } from "./support/provider";
import { MESH_OPERATION_TIMEOUT_MS, operationSignal } from "./support/timeouts";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { getMeshTestTls } from "./support/mesh-tls";
import {
  availablePort, compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  startMeshNode, stopMeshNode, startTlsProxy, stopTlsProxy, type ManagedMeshNode, type MeshHttpNode,
} from "./support/mesh-cluster";

interface Client {
  json<T>(path: string, options?: { method?: string; body?: string }, expectedStatus?: number): Promise<{ data: T }>;
}
interface Chat {
  config: { id: string; name: string };
  state: { status: string; queuedMessages?: Array<{ id: string; content: string }> };
}
interface Snapshot {
  transcript: {
    messages: Array<{ role: string; content: string }>;
  };
}
interface ToolResult {
  ok?: boolean;
  status?: string | number;
  completion?: string;
  code?: string;
  requestId?: string;
  items?: Array<{ id: string }>;
  columns?: string[];
  operations?: Array<[string, string, string]>;
  total?: number;
  content?: unknown;
  data?: { id?: string; file?: { path: string; bytes: number; contentType: string } };
  error?: { code: string };
}
interface Command { name: string; input: Record<string, unknown> }
interface UiAction {
  type: string; actionId: string; clientId: string;
  source: { kind: "chat_turn"; chatId: string; workspaceId: string; turnId: string };
  action: { type: string; workspaceId: string; filePath?: string };
}

function instruction(commands: Command[]): string {
  return `Control request: ${JSON.stringify(commands)}`;
}

async function idle(client: Client, id: string): Promise<void> {
  const chat = await pollUntil(
    async () => (await client.json<Chat>(`/api/chats/${id}`)).data,
    (value) => value.state.status === "idle" || value.state.status === "failed",
    { description: `OpenCode chat ${id} to finish`, timeoutMs: 10_000, formatLastObserved: JSON.stringify },
  );
  expect(chat.state.status).toBe("idle");
}

async function send(client: Client, id: string, message: string, clientId?: string): Promise<Chat> {
  return (await client.json<{ chat: Chat }>(`/api/chats/${id}/messages`, {
    method: "POST", body: JSON.stringify({ message, clientId }),
  })).data.chat;
}

async function results(client: Client, id: string): Promise<ToolResult[]> {
  await idle(client, id);
  const snapshot = (await client.json<Snapshot>(`/api/chats/${id}/snapshot?full=1`)).data;
  const response = snapshot.transcript.messages.findLast(
    (message) => message.role === "assistant" && message.content.startsWith("Control results: "),
  );
  if (!response) throw new Error(`OpenCode did not return Control results: ${JSON.stringify(snapshot)}`);
  return JSON.parse(response.content.slice("Control results: ".length));
}

async function prepare(client: Client, directory: string, executionHost: Record<string, unknown>, name: string) {
  const workspace = (await client.json<{ id: string }>("/api/workspaces", {
    method: "POST", body: JSON.stringify({
      name, directory, executionHost, workspaceType: "directory", allowWorktrees: false,
      allowClankyContext: false,
      serverSettings: { agent: { adapter: "opencode2", provider: "opencode" } },
    }),
  }, 201)).data;
  const model = (await client.json<Array<{ providerID: string; modelID: string; connected: boolean }>>(
    `/api/models?workspaceId=${workspace.id}`,
  )).data.find((value) => value.connected)!;
  expect(model.modelID).toBe("e2e-opencode-model");
  const modelConfig = { providerID: model.providerID, modelID: model.modelID, variant: "" };
  const createChat = async (chatName: string) => (await client.json<Chat>("/api/chats", {
    method: "POST", body: JSON.stringify({ name: chatName, workspaceId: workspace.id, model: modelConfig, useWorktree: false }),
  }, 201)).data.config.id;
  return { workspace, modelConfig, createChat };
}

async function operateWorkspace(
  client: Client, id: string, workspaceId: string, filePath: string, name: string,
  createChat: (name: string) => Promise<string>,
) {
  const createdId = await createChat(name);
  const requestedName = `${name} awaiting approval`;
  await send(client, id, instruction([
    { name: "clanky_list_workspaces", input: {} },
    {
      name: "clanky_execute_operation", input: {
        operationId: "GET /api/workspaces/:id/files/content",
        parameters: [{ name: "id", value: workspaceId }],
        query: [{ name: "path", value: filePath }],
        bodyJson: null, confirmationDescription: null,
      },
    },
    {
      name: "clanky_create_chat", input: {
        name: requestedName, useWorktree: false,
        confirmationDescription: `Create the chat "${requestedName}" in this workspace with automatic permission approval.`,
      },
    },
  ]));
  const output = await results(client, id);
  expect(output[0]?.items?.some((item) => item.id === workspaceId)).toBe(true);
  expect(output[1]?.ok).toBe(true);
  expect(JSON.stringify(output)).toContain("Selected execution host file");
  expect(output.at(-1)).toMatchObject({
    ok: true, code: "confirmation_required", completion: "not_executed",
  });
  expect(output.at(-1)?.requestId).toBeDefined();
  const chats = (await client.json<Chat[]>(`/api/chats?workspaceId=${encodeURIComponent(workspaceId)}`)).data;
  expect(chats.some((chat) => chat.config.name === requestedName)).toBe(false);
  expect((await client.json<Chat>(`/api/chats/${createdId}`)).data.config.name).toBe(name);
  await send(client, id, instruction([
    { name: "clanky_send_chat_message", input: { target: createdId, message: "Work in this workspace." } },
  ]));
  expect((await results(client, id))[0]!.ok).toBe(true);
  await idle(client, createdId);
  const delegated = (await client.json<Snapshot>(`/api/chats/${createdId}/snapshot?full=1`)).data;
  expect(delegated.transcript.messages.some(
    (message) => message.role === "assistant" && message.content.includes("Work in this workspace."),
  )).toBe(true);
  return createdId;
}

test("OpenCode users control workspaces, route browser actions, steer and resume their chat", async () => {
  const application = await E2EApplication.create();
  const sockets: WebSocket[] = [];
  try {
    const directory = join(application.runDirectory, "workspace");
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, "control.txt");
    await Bun.write(filePath, "Selected execution host file");
    await installExternalNativeOpenCodeProvider(application.providerBinDirectory);
    await application.start();
    const host = (await application.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "local")!;
    const { workspace, createChat } = await prepare(application, directory, host.ref, "OpenCode Control workspace");
    const id = await createChat("OpenCode Control");
    const inputFile = createFileAttachment("project.json", "{\"project\":\"OpenCode workspace\"}\n", "application/json");
    await application.json(`/api/chats/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "Inspect the attached files before controlling this workspace.", attachments: [inputFile] }),
    });
    await idle(application, id);
    const fileSnapshot = (await application.json<Snapshot>(`/api/chats/${id}/snapshot?full=1`)).data;
    expect(fileSnapshot.transcript.messages.some((message) =>
      message.role === "assistant" && message.content.includes(expectedFileInspection(inputFile).sha256)
    )).toBe(true);
    const delegatedId = await operateWorkspace(application, id, workspace.id, filePath, "Delegated OpenCode work", createChat);
    const foreignDirectory = join(application.runDirectory, "foreign-workspace");
    await mkdir(foreignDirectory, { recursive: true });
    const foreign = await prepare(application, foreignDirectory, host.ref, "Foreign OpenCode project");
    const foreignId = await foreign.createChat("Foreign project conversation");
    const foreignMessage = "Foreign project conversation must remain private.";
    await send(application, foreignId, foreignMessage);
    await idle(application, foreignId);
    const unauthorizedMessage = "This cross-project instruction must not be delivered.";
    await send(application, id, instruction([
      { name: "clanky_read_chat", input: { target: delegatedId } },
      { name: "clanky_read_chat", input: { target: foreignId } },
      { name: "clanky_send_chat_message", input: { target: foreignId, message: unauthorizedMessage } },
    ]));
    const collaboration = await results(application, id);
    expect(collaboration[0]).toHaveProperty("content");
    expect(JSON.stringify(collaboration[0]?.content)).toContain("Work in this workspace.");
    expect(collaboration[1]?.ok).toBe(false);
    expect(JSON.stringify(collaboration[1])).not.toContain(foreignMessage);
    expect(collaboration[2]?.ok).toBe(false);
    const unchangedForeign = (await application.json<Snapshot>(`/api/chats/${foreignId}/snapshot?full=1`)).data;
    expect(unchangedForeign.transcript.messages.some((message) => message.content.includes(unauthorizedMessage))).toBe(false);

    await application.json(`/api/workspaces/${foreign.workspace.id}`, {
      method: "PUT", body: JSON.stringify({ allowClankyContext: true }),
    });
    const generalId = await foreign.createChat("OpenCode general Clanky access");
    await send(application, generalId, instruction([
      { name: "clanky_list_operations", input: {} },
      {
        name: "clanky_execute_operation", input: {
          operationId: "GET /api/health", parameters: [], query: [],
          bodyJson: null, confirmationDescription: null,
        },
      },
    ]));
    const generalResults = await results(application, generalId);
    expect(generalResults[0]?.columns).toEqual(["operationId", "policy", "description"]);
    expect(generalResults[0]?.total).toBe(generalResults[0]?.operations?.length);
    expect(generalResults[0]?.operations?.some(([operationId]) => operationId === "GET /api/health")).toBe(true);
    expect(generalResults[1]).toMatchObject({ ok: true, completion: "completed" });

    const key = (await application.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "OpenCode browser clients", scopes: ["*"] }),
    })).data.token;
    const clients = [crypto.randomUUID(), crypto.randomUUID()];
    const actions: UiAction[][] = [[], []];
    const RuntimeWebSocket = WebSocket as {
      new(url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
    };
    for (const [index] of clients.entries()) {
      const socket = new RuntimeWebSocket(`${application.baseUrl.replace("http:", "ws:")}/api/ws`, {
        headers: { Authorization: `Bearer ${key}`, Origin: application.baseUrl },
      });
      sockets.push(socket);
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data));
        if (frame.event?.type === "control.ui_action") actions[index]!.push(frame.event);
      };
    }
    await pollUntil(() => sockets.map((socket) => socket.readyState),
      (states) => states.every((state) => state === WebSocket.OPEN),
      { description: "OpenCode browser clients to connect", timeoutMs: 5_000 });
    await Promise.all(sockets.map((socket, index) => subscribeRealtime(socket, {
      kinds: ["action"], types: ["control.ui_action"], targets: { clientId: clients[index]! },
    })));
    const steer = async (message: string, clientId: string) => {
      const chat = await send(application, id, message, clientId);
      const queued = chat.state.queuedMessages!.find((entry) => entry.content === message)!;
      const admission = (await application.json<{ admission: { status: string } }>(
        `/api/chats/${id}/queued-messages/${queued.id}/steer`, { method: "POST", body: "{}" },
      )).data.admission;
      expect(admission.status).toBe("accepted");
    };
    await send(application, id, `Wait for steering.\n${instruction([
      { name: "clanky_list_workspaces", input: {} },
    ])}`, clients[0]);
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${id}`)).data.state.status,
      (status) => status === "streaming",
      { description: "OpenCode Control turn to accept steering", timeoutMs: 10_000 });
    await steer("Continue.", clients[0]!);
    expect((await results(application, id))[0]?.items?.some((item) => item.id === workspace.id)).toBe(true);
    await send(application, id, instruction([
      { name: "clanky_ui_action", input: { action: { type: "open_workspace_file", workspaceId: workspace.id, filePath } } },
    ]), clients[1]);
    const action = await pollUntil(() => actions[1]!.at(-1),
      (value) => value?.source.kind === "chat_turn" && value.source.chatId === id,
      { description: "new Control turn to open its file in the originating tab", timeoutMs: 10_000 });
    expect(action!.clientId).toBe(clients[1]!);
    expect(action!.action.filePath).toBe(filePath);
    expect(actions[0]).toHaveLength(0);
    await application.json(`/api/control/ui-actions/${action!.actionId}/ack`, {
      method: "POST", body: JSON.stringify({
        clientId: action!.clientId, source: action!.source,
        outcome: { status: "opened", action: action!.action },
      }),
    });
    expect((await results(application, id))[0]?.status).toBe("opened");
    for (const socket of sockets) socket.close();
    await pollUntil(() => sockets.map((socket) => socket.readyState),
      (states) => states.every((state) => state === WebSocket.CLOSED),
      { description: "OpenCode browser clients to disconnect", timeoutMs: 5_000 });
    await application.restart();
    await send(application, id, instruction([{ name: "clanky_list_chats", input: { workspace: workspace.id } }]));
    const resumed = await results(application, id);
    expect(resumed[0]?.items).toBeDefined();
    expect(JSON.stringify(resumed)).toContain("Delegated OpenCode work");
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await pollUntil(() => sockets.map((socket) => socket.readyState),
        (states) => states.every((state) => state === WebSocket.CLOSED),
        { description: "OpenCode browser clients to disconnect", timeoutMs: 5_000 });
    } finally {
      await application.cleanup();
    }
  }
});

test("General-access OpenCode transfers binary files across hosts and administers credentials with human approval", async () => {
  const application = await E2EApplication.create();
  let worker: ManagedMeshNode | undefined;
  let controller: (MeshHttpNode & Pick<ManagedMeshNode, "tlsProxy">) | undefined;
  try {
    await installExternalNativeOpenCodeProvider(application.providerBinDirectory);
    const tls = await getMeshTestTls();
    const port = await availablePort();
    await application.start({
      disablePasskey: false, requestHostname: "localhost", port,
      env: {
        NODE_EXTRA_CA_CERTS: tls.certificatePath, CLANKY_PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
        CLANKY_TRUST_PROXY: "true", CLANKY_TRUST_PROXY_HEADERS: "proto,host",
      },
    });
    const human = new CookieJar();
    await bootstrapOwner(application, human);
    const client: Client = {
      async json<T>(path: string, options?: { method?: string; body?: string }, expectedStatus = 200) {
        const response = await requestWithCookies(application, human, path, {
          ...options, headers: { origin: application.baseUrl },
        });
        expect(response.status, `${options?.method ?? "GET"} ${new URL(path, application.baseUrl).pathname}`).toBe(expectedStatus);
        return { data: await response.json() as T };
      },
    };
    const enrollmentKey = (await client.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "Mesh enrollment fixture", scopes: ["*"] }),
    })).data.token;
    controller = { baseUrl: application.baseUrl, dataDir: application.dataDirectory, apiKey: enrollmentKey };
    await startTlsProxy(controller, port);
    await client.json("/api/mesh/endpoint", {
      method: "POST", body: JSON.stringify({ meshEndpoint: controller.meshEndpoint }),
    });
    worker = await startMeshNode({
      role: "worker", command: await compiledClankyCommand(), instanceName: "Native transfer host",
      environment: { PATH: `${application.providerBinDirectory}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    await enrollMeshWorker(controller, worker);
    const hosts = (await client.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts")).data;
    const local = hosts.find((entry) => entry.ref["kind"] === "local")!;
    const remote = hosts.find((entry) => entry.ref["kind"] === "mesh")!;
    const localDirectory = join(application.runDirectory, "destination-workspace");
    const remoteDirectory = join(worker.dataDir, "native-workspace");
    await Promise.all([mkdir(localDirectory), mkdir(remoteDirectory)]);
    const destination = await prepare(client, localDirectory, local.ref, "Transfer destination");
    const origin = await prepare(client, remoteDirectory, remote.ref, "General native transfer");
    await client.json(`/api/workspaces/${origin.workspace.id}`, {
      method: "PUT", body: JSON.stringify({ allowClankyContext: true }),
    });
    const id = await origin.createChat("Native administration and transfer");
    const call = async (operationId: string, input: Record<string, unknown> = {}): Promise<ToolResult> => {
      await send(client, id, instruction([{
        name: "clanky_execute_operation",
        input: { operationId, parameters: [], query: [], bodyJson: null, confirmationDescription: null, ...input },
      }]));
      return (await results(client, id))[0]!;
    };
    expect(await call("GET /api/users")).toMatchObject({ ok: true, completion: "completed" });
    expect(await call("GET /api/control/credentials")).toMatchObject({ ok: true, completion: "completed" });

    const target = join(localDirectory, "artifact.bin");
    const initial = new TextEncoder().encode("Existing artifact");
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
    const bodyPath = join(remoteDirectory, "upload.bin");
    const headerPath = join(remoteDirectory, "conditions.json");
    await Promise.all([Bun.write(target, initial), Bun.write(bodyPath, bytes)]);
    const filesystemPath = `/api/workspaces/${destination.workspace.id}/files/filesystem`;
    const ownerId = crypto.randomUUID();
    const lock = (await client.json<{ lock: { token: string } }>(filesystemPath, {
      method: "POST", body: JSON.stringify({
        operation: "lock", path: target, ownerId, scope: "exclusive", depth: "0",
        owner: "Artifact editor", timeoutSeconds: 300,
      }),
    })).data.lock;
    await Bun.write(headerPath, JSON.stringify({
      "x-clanky-file-conditions": JSON.stringify({
        davIf: [{ terms: [{ kind: "token", value: lock.token, not: false }] }],
      }),
    }));
    const pending = await call("PUT /api/workspaces/:id/files/filesystem/content", {
      parameters: [{ name: "id", value: destination.workspace.id }],
      query: [{ name: "path", value: target }],
      bodyFile: { path: bodyPath, contentType: "application/octet-stream" },
      headersFile: { path: headerPath },
      confirmationDescription: "Replace the artifact in Transfer destination with the uploaded binary file.",
    });
    expect(pending).toMatchObject({ ok: true, code: "confirmation_required", completion: "not_executed" });
    if (!pending.requestId) throw new Error("The native upload did not return a human approval request.");
    expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(initial);
    const frozen = (await client.json<{ operation: Record<string, unknown> }>(`/api/control/requests/${pending.requestId}`)).data;
    expect(frozen.operation).toMatchObject({ bodyJson: null, bodyFile: { path: bodyPath }, headersFile: { path: headerPath } });
    expect(JSON.stringify(frozen).includes(lock.token)).toBe(false);
    await Promise.all([
      Bun.write(bodyPath, "Source edited after requesting approval"),
      Bun.write(headerPath, JSON.stringify({ "x-clanky-file-conditions": JSON.stringify({ ifMatch: '"changed"' }) })),
    ]);
    expect(await call("POST /api/control/requests/:id/decision", {
      parameters: [{ name: "id", value: pending.requestId }], bodyJson: JSON.stringify({ approved: true }),
    })).toMatchObject({ ok: false });
    expect(await call("PUT /api/control/approval-policy", {
      bodyJson: JSON.stringify({ requireApproval: false }),
    })).toMatchObject({ ok: false });

    const keyPath = join(remoteDirectory, "native-key.json");
    const keyBodyPath = join(remoteDirectory, "key-request.json");
    await Bun.write(keyBodyPath, JSON.stringify({ name: "Native managed key", scopes: ["*"] }));
    const keyRequest = await call("POST /api/api-keys", {
      bodyFile: { path: keyBodyPath }, responseFile: { path: keyPath },
      confirmationDescription: "Create Native managed key with full access for this account and save it privately on Native transfer host.",
    });
    expect(keyRequest).toMatchObject({ ok: true, code: "confirmation_required", completion: "not_executed" });
    if (!keyRequest.requestId) throw new Error("Credential creation did not require human approval.");
    expect(await Bun.file(keyPath).exists()).toBe(false);
    const before = (await client.json<Array<{ name: string }>>("/api/api-keys")).data;
    expect(before.some((key) => key.name === "Native managed key")).toBe(false);
    await Bun.write(keyBodyPath, JSON.stringify({ name: "Changed after approval request", scopes: [] }));
    await client.json(`/api/control/requests/${keyRequest.requestId}/decision`, {
      method: "POST", body: JSON.stringify({ approved: true }),
    });
    const keyResult = (await client.json<{ result: ToolResult }>(`/api/control/requests/${keyRequest.requestId}`)).data.result;
    expect(keyResult).toMatchObject({ ok: true, completion: "completed", data: { file: { path: keyPath } } });
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    const issued = await Bun.file(keyPath).json() as { token: string };
    expect(typeof issued.token === "string" && issued.token.length > 0).toBe(true);
    expect(JSON.stringify(keyResult).includes(issued.token)).toBe(false);
    const keys = (await client.json<Array<{ name: string }>>("/api/api-keys")).data;
    expect(keys.some((key) => key.name === "Native managed key")).toBe(true);
    const transcript = (await client.json<Snapshot>(`/api/chats/${id}/snapshot?full=1`)).data;
    expect(JSON.stringify(transcript).includes(issued.token)).toBe(false);

    const apiKeyBrowser = new CookieJar();
    const login = await requestWithCookies(application, apiKeyBrowser, "/api/passkey-auth/api-key", {
      method: "POST", headers: { origin: application.baseUrl }, body: JSON.stringify({ apiKey: issued.token }),
    });
    expect(login.status).toBe(200);
    await login.body?.cancel();
    for (const [path, body] of [
      [`/api/control/requests/${pending.requestId}/decision`, { approved: true }],
      ["/api/control/approval-policy", { requireApproval: false }],
    ] as const) {
      const denied = await requestWithCookies(application, apiKeyBrowser, path, {
        method: path.endsWith("decision") ? "POST" : "PUT",
        headers: { origin: application.baseUrl }, body: JSON.stringify(body),
      });
      expect(denied.status).toBe(403);
      await denied.body?.cancel();
    }
    expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(initial);
    await client.json(`/api/control/requests/${pending.requestId}/decision`, {
      method: "POST", body: JSON.stringify({ approved: true }),
    });
    const completed = (await client.json<{ result: ToolResult }>(`/api/control/requests/${pending.requestId}`)).data.result;
    expect(completed).toMatchObject({ ok: true, completion: "completed" });
    expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(bytes);
    await client.json(filesystemPath, {
      method: "POST", body: JSON.stringify({ operation: "unlock", path: target, ownerId, token: lock.token }),
    });

    const downloadPath = join(remoteDirectory, "download.bin");
    const rangePath = join(remoteDirectory, "range.json");
    await Bun.write(rangePath, JSON.stringify({ range: "bytes=0-" }));
    const downloaded = await call("GET /api/workspaces/:id/files/filesystem/content", {
      parameters: [{ name: "id", value: destination.workspace.id }],
      query: [{ name: "path", value: target }], headersFile: { path: rangePath },
      responseFile: { path: downloadPath },
    });
    expect(downloaded).toMatchObject({
      ok: true, status: 206, completion: "completed",
      data: { file: { path: downloadPath, bytes: bytes.length, contentType: "application/octet-stream" } },
    });
    expect(new Uint8Array(await Bun.file(downloadPath).arrayBuffer())).toEqual(bytes);
    expect((await stat(downloadPath)).mode & 0o777).toBe(0o600);

    const invitationPath = join(remoteDirectory, "account-invitation.json");
    const invitationRequest = await call("POST /api/users", {
      bodyJson: JSON.stringify({ username: "artifact-reviewer", role: "user" }),
      responseFile: { path: invitationPath },
      confirmationDescription: "Create the artifact-reviewer account and save its private setup invitation on Native transfer host.",
    });
    expect(invitationRequest).toMatchObject({ ok: true, code: "confirmation_required", completion: "not_executed" });
    if (!invitationRequest.requestId) throw new Error("Account invitation did not require human approval.");
    await client.json(`/api/control/requests/${invitationRequest.requestId}/decision`, {
      method: "POST", body: JSON.stringify({ approved: true }),
    });
    const invitation = await Bun.file(invitationPath).json() as { setupLink: { url: string } };
    const setupUrl = new URL(invitation.setupLink.url);
    const setup = await fetch(new URL("/api/user-setup/options", setupUrl), {
      method: "POST", headers: { origin: setupUrl.origin, "content-type": "application/json" },
      body: JSON.stringify({ token: setupUrl.searchParams.get("token") }), signal: operationSignal(),
    });
    expect(setup.status).toBe(200);
    await setup.body?.cancel();
  } catch (error) {
    console.error(await application.diagnostics());
    if (worker) console.error(await meshNodeDiagnostics(worker));
    throw error;
  } finally {
    try { await application.cleanup(); }
    finally {
      try { if (worker) await stopMeshNode(worker); }
      finally { if (controller) await stopTlsProxy(controller); }
    }
  }
});

test("Mesh users operate Clanky through OpenCode Control on their selected worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-opencode-control-e2e-"));
  const nodes: ManagedMeshNode[] = [];
  const notifications: unknown[] = [];
  const webhook = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      notifications.push(await request.json());
      return Response.json({ accepted: true }, { status: 201 });
    },
  });
  try {
    const bin = join(directory, "bin");
    await installExternalNativeOpenCodeProvider(bin);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller", command, instanceName: "OpenCode controller",
    });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker", command, instanceName: "OpenCode worker",
      environment: { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` },
    });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const client: Client = {
      async json<T>(path: string, options?: { method?: string; body?: string }, expectedStatus = 200) {
        const response = await meshJsonRequest<T>(controller, path, {
          method: options?.method, body: options?.body ? JSON.parse(options.body) : undefined,
        });
        if (response.status !== expectedStatus) throw new Error(`Mesh ${path}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
        return { data: response.body };
      },
    };
    const host = (await client.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "mesh")!;
    const workspaceDirectory = join(worker.dataDir, "workspace");
    const filePath = join(workspaceDirectory, "control.txt");
    await client.json(`/api/execution-hosts/mesh/${host.ref["nodeId"]}/exec`, {
      method: "POST", body: JSON.stringify({
        command: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(filePath)}, "Selected execution host file");`],
        cwd: worker.dataDir, timeoutMs: MESH_OPERATION_TIMEOUT_MS,
      }),
    });
    const { workspace, createChat } = await prepare(client, workspaceDirectory, host.ref, "Mesh OpenCode Control");
    await client.json("/api/preferences/notifications", {
      method: "PUT", body: JSON.stringify({
        webhookUrl: `http://127.0.0.1:${webhook.port}/api/webhooks/clanky/mesh-fixture-token`,
      }),
    });
    const id = await createChat("Mesh Control conversation");
    const notification = {
      title: "Mesh work ready", shortDescription: "Your requested Mesh notification.",
      markdownContent: "**Ready for review.**",
    };
    await send(client, id, "Send me this notification.\n" + instruction([
      { name: "clanky_send_notification", input: notification },
    ]));
    expect((await results(client, id))[0]).toMatchObject({ ok: true, completion: "completed", status: "accepted" });
    expect(notifications).toEqual([notification]);
    await operateWorkspace(client, id, workspace.id, filePath, "Delegated Mesh work", createChat);
  } catch (error) {
    for (const node of nodes) console.error(await meshNodeDiagnostics(node));
    throw error;
  } finally {
    try {
      for (const node of [...nodes].reverse()) await stopMeshNode(node);
    } finally {
      try { await webhook.stop(true); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});
