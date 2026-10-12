import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { E2EApplication } from "./support/application";
import { pollUntil } from "./support/polling";
import { installExternalNativeOpenCodeProvider } from "./support/provider";
import { createFixtureLiveOffer, startVoiceProvider, stopVoiceProvider, type ManagedVoiceProvider } from "./support/voice-provider";
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
    logs: Array<{ details?: { logKind?: string; callId?: string } }>;
  };
}
interface ToolResult {
  ok: boolean;
  data?: { config?: { id: string } };
  error?: { code: string };
}
interface Command { name: string; input: Record<string, unknown> }
interface UiAction {
  type: string; actionId: string; chatId: string; clientId: string; turnId: string;
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

async function operateWorkspace(client: Client, id: string, workspaceId: string, filePath: string, name: string) {
  await send(client, id, instruction([
    { name: "clanky_list_workspaces", input: {} },
    { name: "clanky_read_workspace_file", input: { workspaceId, path: filePath } },
    { name: "clanky_create_chat", input: { name, useWorktree: false } },
  ]));
  const output = await results(client, id);
  expect(output.every((result) => result.ok)).toBe(true);
  expect(JSON.stringify(output)).toContain("Selected execution host file");
  const createdId = output.at(-1)?.data?.config?.id;
  expect(createdId).toBeDefined();
  expect((await client.json<Chat>(`/api/chats/${createdId}`)).data.config.name).toBe(name);
  await send(client, id, instruction([
    { name: "clanky_send_message_to_chat", input: { chatId: createdId, message: "Work in this workspace." } },
  ]));
  expect((await results(client, id))[0]!.ok).toBe(true);
  await idle(client, createdId!);
  const delegated = (await client.json<Snapshot>(`/api/chats/${createdId}/snapshot?full=1`)).data;
  expect(delegated.transcript.messages.some(
    (message) => message.role === "assistant" && message.content.includes("Work in this workspace."),
  )).toBe(true);
}

async function configureVoice(client: Client, provider: ManagedVoiceProvider): Promise<void> {
  await client.json("/api/voice/settings", {
    method: "PUT", body: JSON.stringify({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      models: { transcription: "gpt-transcribe", text: "e2e-text" }, languageHints: ["en"],
      live: { useVoiceProvider: true, baseUrl: "", model: "gpt-live-1" },
    }),
  });
}

async function useLiveVoice(client: Client, options: {
  chatId: string; clientId: string; scenario: "ordinary" | "steer"; expectedText: string;
}): Promise<string> {
  const { chatId, clientId, scenario, expectedText } = options;
  expect((await client.json<{ supported: boolean }>(`/api/chats/${chatId}/live-voice`)).data.supported).toBe(true);
  const call = (await client.json<{ call: { id: string; status: string } }>(`/api/chats/${chatId}/live-voice`, {
    method: "POST", body: JSON.stringify({ clientId, sdp: createFixtureLiveOffer(scenario) }),
  }, 201)).data.call;
  expect(call.status).toBe("active");
  await pollUntil(async () => (await client.json<Snapshot>(`/api/chats/${chatId}/snapshot?full=1`)).data,
    (snapshot) => {
      const messages = snapshot.transcript.messages;
      const instructionIndex = messages.findLastIndex((message) => message.role === "user"
        && message.content.includes(scenario === "ordinary"
          ? "Describe the ordinary Live chat request."
          : "Wait for a steering instruction, then list workspaces for the Live caller."));
      const subsequent = messages.slice(instructionIndex + 1);
      // Native work can finish before the steering admission is persisted in the transcript.
      return instructionIndex >= 0 && subsequent.some((message) => message.role === "assistant" && message.content.includes(expectedText))
        && (scenario === "ordinary" || subsequent.some((message) => message.role === "user" && message.content.includes("Live steering request ")));
    },
    { description: "voice instruction and native agent result", timeoutMs: 10_000, formatLastObserved: JSON.stringify });
  await idle(client, chatId);
  const closed = (await client.json<{ status: string; summarySaved: boolean }>(`/api/chats/${chatId}/live-voice/${call.id}/close`, {
    method: "POST",
  })).data;
  expect(closed).toMatchObject({ status: "closed", summarySaved: true });
  return call.id;
}

test("OpenCode users use Live voice, control workspaces, route browser actions, steer and resume their chat", async () => {
  const application = await E2EApplication.create();
  const sockets: WebSocket[] = [];
  let voiceProvider: ManagedVoiceProvider | undefined;
  try {
    const directory = join(application.runDirectory, "workspace");
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, "control.txt");
    await Bun.write(filePath, "Selected execution host file");
    await installExternalNativeOpenCodeProvider(application.providerBinDirectory);
    voiceProvider = await startVoiceProvider(application.runDirectory);
    const environment = { NODE_EXTRA_CA_CERTS: voiceProvider.certificatePath };
    await application.start({ env: environment });
    const host = (await application.json<Array<{ ref: Record<string, unknown> }>>("/api/execution-hosts"))
      .data.find((entry) => entry.ref["kind"] === "local")!;
    const { workspace, modelConfig, createChat } = await prepare(application, directory, host.ref, "OpenCode Control workspace");
    const ordinary = await createChat("Ordinary OpenCode chat");
    await configureVoice(application, voiceProvider);
    await useLiveVoice(application, {
      chatId: ordinary, clientId: crypto.randomUUID(), scenario: "ordinary",
      expectedText: "Describe the ordinary Live chat request.",
    });
    await application.json("/api/preferences/quick-chat", {
      method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, model: modelConfig, useWorktree: false }),
    });
    const id = await createChat("OpenCode Control");
    await operateWorkspace(application, id, workspace.id, filePath, "Delegated OpenCode work");

    const key = (await application.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "OpenCode browser clients", scopes: ["*"] }),
    })).data.token;
    const clients = [crypto.randomUUID(), crypto.randomUUID()];
    const actions: UiAction[][] = [[], []];
    const RuntimeWebSocket = WebSocket as {
      new(url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
    };
    for (const [index, clientId] of clients.entries()) {
      const socket = new RuntimeWebSocket(`${application.baseUrl.replace("http:", "ws:")}/api/ws?clientId=${clientId}`, {
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
      { name: "clanky_open_workspace", input: { workspaceId: workspace.id } },
    ])}`, clients[0]);
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${id}`)).data.state.status,
      (status) => status === "streaming",
      { description: "OpenCode Control turn to accept steering", timeoutMs: 10_000 });
    await steer("Continue.", clients[1]!);
    const mixed = await results(application, id);
    expect(mixed[0]!.ok).toBe(true);
    expect(mixed[1]!.error?.code).toBe("control_client_unavailable");
    expect(actions.flat()).toHaveLength(0);
    await send(application, id, instruction([
      { name: "clanky_open_workspace_file", input: { workspaceId: workspace.id, filePath } },
    ]), clients[1]);
    const action = await pollUntil(() => actions[1]!.at(-1), (value) => value?.chatId === id,
      { description: "new Control turn to open its file in the originating tab", timeoutMs: 10_000 });
    expect(action!.clientId).toBe(clients[1]!);
    expect(action!.action.filePath).toBe(filePath);
    expect(actions[0]).toHaveLength(0);
    await application.json(`/api/control/ui-actions/${action!.actionId}/ack`, {
      method: "POST", body: JSON.stringify({
        clientId: action!.clientId, chatId: id, turnId: action!.turnId,
        outcome: { status: "opened", action: action!.action },
      }),
    });
    expect((await results(application, id))[0]!.ok).toBe(true);
    const voiceCallId = await useLiveVoice(application, {
      chatId: id, clientId: clients[1]!, scenario: "steer", expectedText: "OpenCode Control workspace",
    });
    for (const socket of sockets) socket.close();
    await pollUntil(() => sockets.map((socket) => socket.readyState),
      (states) => states.every((state) => state === WebSocket.CLOSED),
      { description: "OpenCode browser clients to disconnect", timeoutMs: 5_000 });
    await application.restart({ env: environment });
    expect((await application.json<{ supported: boolean }>(`/api/chats/${id}/live-voice`)).data.supported).toBe(true);
    await send(application, id, instruction([{ name: "clanky_list_chats", input: { workspaceId: workspace.id } }]));
    const resumed = await results(application, id);
    expect(resumed[0]!.ok).toBe(true);
    expect(JSON.stringify(resumed)).toContain("Delegated OpenCode work");
    expect((await application.json<Snapshot>(`/api/chats/${id}/snapshot?full=1`)).data.transcript.logs
      .some((entry) => entry.details?.logKind === "voice_call" && entry.details.callId === voiceCallId)).toBe(true);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await application.cleanup();
    } finally {
      if (voiceProvider) await stopVoiceProvider(voiceProvider);
    }
  }
});

test("Mesh users operate Clanky through OpenCode Control on their selected worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-opencode-control-e2e-"));
  const nodes: ManagedMeshNode[] = [];
  let voiceProvider: ManagedVoiceProvider | undefined;
  try {
    const bin = join(directory, "bin");
    await installExternalNativeOpenCodeProvider(bin);
    voiceProvider = await startVoiceProvider(directory);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller", command, instanceName: "OpenCode controller",
      environment: { NODE_EXTRA_CA_CERTS: voiceProvider.certificatePath },
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
    const { workspace, modelConfig, createChat } = await prepare(client, workspaceDirectory, host.ref, "Mesh OpenCode Control");
    await client.json("/api/preferences/quick-chat", {
      method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, model: modelConfig, useWorktree: false }),
    });
    const id = await createChat("Mesh Control conversation");
    await operateWorkspace(client, id, workspace.id, filePath, "Delegated Mesh work");
    await configureVoice(client, voiceProvider);
    const voiceCallId = await useLiveVoice(client, {
      chatId: id, clientId: crypto.randomUUID(), scenario: "steer", expectedText: "Mesh OpenCode Control",
    });
    expect((await client.json<Snapshot>(`/api/chats/${id}/snapshot?full=1`)).data.transcript.logs
      .some((entry) => entry.details?.logKind === "voice_call" && entry.details.callId === voiceCallId)).toBe(true);
  } catch (error) {
    for (const node of nodes) console.error(await meshNodeDiagnostics(node));
    throw error;
  } finally {
    try {
      for (const node of [...nodes].reverse()) await stopMeshNode(node);
    } finally {
      try {
        if (voiceProvider) await stopVoiceProvider(voiceProvider);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
