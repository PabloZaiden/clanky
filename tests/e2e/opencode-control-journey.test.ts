import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { E2EApplication } from "./support/application";
import { createFileAttachment, expectedFileInspection } from "./support/attachments";
import { pollUntil } from "./support/polling";
import { subscribeRealtime } from "./support/realtime";
import { installExternalNativeOpenCodeProvider } from "./support/provider";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, meshNodeDiagnostics,
  startMeshNode, stopMeshNode, type ManagedMeshNode,
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
  status?: string;
  completion?: string;
  code?: string;
  requestId?: string;
  items?: Array<{ id: string }>;
  columns?: string[];
  operations?: Array<[string, string, string]>;
  total?: number;
  content?: unknown;
  data?: { id?: string };
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

test("Mesh users operate Clanky through OpenCode Control on their selected worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-opencode-control-e2e-"));
  const nodes: ManagedMeshNode[] = [];
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
    const id = await createChat("Mesh Control conversation");
    await operateWorkspace(client, id, workspace.id, filePath, "Delegated Mesh work", createChat);
  } catch (error) {
    for (const node of nodes) console.error(await meshNodeDiagnostics(node));
    throw error;
  } finally {
    try {
      for (const node of [...nodes].reverse()) await stopMeshNode(node);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
