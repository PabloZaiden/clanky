import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { subscribeRealtime } from "./support/realtime";
import { installExternalNativeCopilotProvider } from "./support/provider";
import { E2E_IMAGE_DATA } from "./providers/image-input";

const E2E_IMAGE_RECEIPT = "E2E image received: image/png; PNG signature OK";

interface ExecutionHost {
  ref: Record<string, string>;
}

interface Workspace {
  id: string;
  name: string;
}

interface Model {
  connected: boolean;
  modelID: string;
  providerID: string;
}

interface Chat {
  config: {
    id: string;
  };
  state: {
    status: string;
    queuedMessages?: Array<{ id: string; content: string }>;
    harness?: { questions?: Array<{ status: string; answers?: string[][] }> };
  };
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      content: string;
      role: string;
      attachments?: Array<{ data: string; mimeType: string }>;
    }>;
    toolCalls?: Array<{ output: unknown }>;
  };
}

function createImageAttachment() {
  return {
    id: crypto.randomUUID(),
    filename: "e2e-image.png",
    mimeType: "image/png",
    data: E2E_IMAGE_DATA,
    size: Buffer.from(E2E_IMAGE_DATA, "base64").byteLength,
  };
}

async function waitForChatIdle(application: E2EApplication, chatId: string): Promise<Chat> {
  const chat = await pollUntil(
    async () => (await application.json<Chat>(`/api/chats/${chatId}`)).data,
    (current) => current.state.status === "idle" || current.state.status === "failed",
    {
      description: `chat ${chatId} to finish its turn`,
      timeoutMs: 10_000,
      formatLastObserved: (current) => JSON.stringify({ status: current.state.status }),
    },
  );
  expect(chat.state.status).toBe("idle");
  return chat;
}

async function waitForToolResult(
  application: E2EApplication,
  chatId: string,
  workspaceName: string,
  expectedCount: number,
): Promise<ChatSnapshot> {
  return await pollUntil(
    async () => (
      await application.json<ChatSnapshot>(`/api/chats/${chatId}/snapshot?full=1`)
    ).data,
    (snapshot) => snapshot.transcript.messages.filter(
      (message) => message.role === "assistant" && message.content.includes(workspaceName),
    ).length >= expectedCount,
    {
      description: `Codex to return ${String(expectedCount)} public workspace-list results`,
      timeoutMs: 10_000,
      formatLastObserved: (snapshot) => JSON.stringify({
        assistantMessages: snapshot.transcript.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content.slice(0, 300)),
      }),
    },
  );
}

async function waitForImageReceipt(
  application: E2EApplication,
  chatId: string,
  expectedCount = 1,
): Promise<ChatSnapshot> {
  return await pollUntil(
    async () => (
      await application.json<ChatSnapshot>(`/api/chats/${chatId}/snapshot?full=1`)
    ).data,
    (snapshot) => snapshot.transcript.messages
      .filter((message) => message.role === "assistant")
      .reduce((count, message) => count + message.content.split(E2E_IMAGE_RECEIPT).length - 1, 0) >= expectedCount,
    {
      description: `provider response in chat ${chatId} to confirm image receipt`,
      timeoutMs: 10_000,
      formatLastObserved: (snapshot) => JSON.stringify({
        assistantMessages: snapshot.transcript.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content.slice(0, 300)),
      }),
    },
  );
}

test("Copilot users inspect images and steer queued Control work across clients", async () => {
  const application = await E2EApplication.create();
  const sockets: WebSocket[] = [];
  try {
    const git = await createGitFixture(application.runDirectory);
    await installExternalNativeCopilotProvider(application.providerBinDirectory);
    await application.start();
    const local = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data
      .find((host) => host.ref["kind"] === "local")!;
    const workspaceName = "Copilot shared chat workspace";
    const workspace = (await application.json<Workspace>("/api/workspaces", {
      method: "POST", body: JSON.stringify({
        name: workspaceName, directory: git.repositoryDirectory, executionHost: local.ref,
        serverSettings: { agent: { adapter: "copilot", provider: "copilot" } },
      }),
    }, 201)).data;
    const model = (await application.json<Model[]>(`/api/models?workspaceId=${workspace.id}`)).data
      .find((entry) => entry.providerID === "copilot" && entry.connected)!;
    expect(model.modelID).toBe("e2e-copilot-model");
    const modelConfig = { providerID: model.providerID, modelID: model.modelID, variant: "" };
    const createChat = async (name: string) => (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name, workspaceId: workspace.id, model: modelConfig, useWorktree: false, baseBranch: git.branch,
      }),
    }, 201)).data.config.id;
    const ordinaryId = await createChat("Ordinary Copilot chat");
    await application.json<{ chat: Chat }>(`/api/chats/${ordinaryId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "Inspect this attached image.",
        attachments: [createImageAttachment()],
      }),
    });
    await waitForChatIdle(application, ordinaryId);
    await waitForImageReceipt(application, ordinaryId);

    await application.json("/api/preferences/quick-chat", {
      method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, model: modelConfig, useWorktree: false }),
    });
    const chatId = await createChat("Copilot control steering");
    const key = (await application.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "Copilot public realtime", scopes: ["*"] }),
    })).data.token;
    type UiAction = {
      type: string; actionId: string; clientId: string;
      source: { kind: "chat_turn"; chatId: string; workspaceId: string; turnId: string };
      action: { type: string; workspaceId: string };
    };
    const clients = [crypto.randomUUID(), crypto.randomUUID()];
    const actions: UiAction[][] = [[], []];
    const RuntimeWebSocket = WebSocket as {
      new(url: string | URL, protocols?: string | string[]): WebSocket;
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
      { description: "two Copilot browser clients to connect", timeoutMs: 5_000 });
    await Promise.all(sockets.map((socket, index) => subscribeRealtime(socket, {
      kinds: ["action"], types: ["control.ui_action"], targets: { clientId: clients[index]! },
    })));
    const send = async (
      message: string,
      clientId: string,
      attachments: ReturnType<typeof createImageAttachment>[] = [],
    ) => (await application.json<{ chat: Chat }>(
      `/api/chats/${chatId}/messages`,
      { method: "POST", body: JSON.stringify({ message, attachments, clientId }) },
    )).data.chat;
    const steer = async (
      message: string,
      clientId: string,
      attachments: ReturnType<typeof createImageAttachment>[] = [],
    ) => {
      const queued = await send(message, clientId, attachments);
      const input = queued.state.queuedMessages!.find((entry) => entry.content === message)!;
      const admission = (await application.json<{ admission: { status: string } }>(
        `/api/chats/${chatId}/queued-messages/${input.id}/steer`, { method: "POST", body: "{}" },
      )).data.admission;
      expect(admission.status).toBe("accepted");
    };
    const waitForActive = async () => await pollUntil(
      async () => (await application.json<Chat>(`/api/chats/${chatId}`)).data.state.status,
      (status) => status === "streaming", { description: "Copilot native turn to become active", timeoutMs: 10_000 },
    );
    await send("Wait for a steering instruction, then open the workspace.", clients[0]!, [createImageAttachment()]);
    await waitForActive();
    await steer("Change the request, but keep waiting.", clients[1]!, [createImageAttachment()]);
    await steer("Finish the request and open the workspace.", clients[0]!);
    await waitForChatIdle(application, chatId);
    const mixed = await waitForToolResult(application, chatId, workspaceName, 1);
    expect(mixed.transcript.messages.some((message) => message.role === "assistant"
      && message.content.includes("Change the request, but keep waiting.")
      && message.content.includes("Finish the request and open the workspace.")
      && message.content.includes("control_client_unavailable")
      && message.content.includes(E2E_IMAGE_RECEIPT))).toBe(true);
    await waitForImageReceipt(application, chatId, 2);
    expect(actions.flat()).toHaveLength(0);

    await send("Wait for a steering instruction before starting the queued work.", clients[0]!);
    await waitForActive();
    const first = "First grouped instruction: open the workspace.";
    const second = "Second grouped instruction: include its name.";
    const other = "Another-tab instruction: open the workspace.";
    await send(first, clients[0]!);
    await send(second, clients[0]!);
    await send(other, clients[1]!);
    await steer("Finish this turn and drain the queued requests.", clients[0]!);
    for (const index of [0, 1]) {
      const action = await pollUntil(() => actions[index]!.at(-1),
        (value) => value?.source.kind === "chat_turn" && value.source.chatId === chatId,
        { description: `queued turn to route its browser action to client ${index}`, timeoutMs: 10_000 });
      expect(action!.clientId).toBe(clients[index]!);
      await application.json(`/api/control/ui-actions/${action!.actionId}/ack`, {
        method: "POST", body: JSON.stringify({
          clientId: action!.clientId, source: action!.source,
          outcome: { status: "opened", action: action!.action },
        }),
      });
    }
    await waitForChatIdle(application, chatId);
    const grouped = (await application.json<ChatSnapshot>(`/api/chats/${chatId}/snapshot?full=1`)).data;
    expect(grouped.transcript.messages.some((message) => message.role === "assistant"
      && message.content.includes(`${first}\n${second}`))).toBe(true);
    expect(grouped.transcript.messages.some((message) => message.role === "assistant"
      && message.content.includes(other) && !message.content.includes(first))).toBe(true);
    expect(actions.map((entries) => entries.length)).toEqual([1, 1]);
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await pollUntil(() => sockets.map((socket) => socket.readyState),
        (states) => states.every((state) => state === WebSocket.CLOSED),
        { description: "Copilot browser clients to disconnect", timeoutMs: 5_000 });
    } finally {
      await application.cleanup();
    }
  }
});
