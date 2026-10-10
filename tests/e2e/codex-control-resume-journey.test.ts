import { expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { installExternalCodexProvider, installExternalNativeCopilotProvider } from "./support/provider";
import { startVoiceProvider, stopVoiceProvider, type ManagedVoiceProvider } from "./support/voice-provider";

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
    }>;
    logs: Array<{ id: string; message: string; details?: { logKind?: string; callId?: string } }>;
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

test("Codex control chat resumes with its tools after restarting Clanky", async () => {
  const application = await E2EApplication.create();
  let voiceProvider: ManagedVoiceProvider | undefined;
  try {
    const git = await createGitFixture(application.runDirectory);
    await installExternalCodexProvider(application.providerBinDirectory);
    voiceProvider = await startVoiceProvider(application.runDirectory);
    const environment = { NODE_EXTRA_CA_CERTS: voiceProvider.certificatePath };
    await application.start({ env: environment });

    const hosts = (await application.json<ExecutionHost[]>("/api/execution-hosts")).data;
    const localHost = hosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();

    const workspaceName = "Codex control resume workspace";
    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: workspaceName,
          directory: git.repositoryDirectory,
          executionHost: localHost!.ref,
          serverSettings: {
            agent: { adapter: "codex", provider: "codex" },
          },
        }),
      },
      201,
    )).data;

    const models = (await application.json<Model[]>(
      `/api/models?workspaceId=${encodeURIComponent(workspace.id)}`,
    )).data;
    const model = models.find(
      (candidate) => candidate.providerID === "codex" && candidate.connected,
    );
    expect(model?.modelID).toBe("e2e-codex-model");
    const modelConfig = {
      providerID: model!.providerID,
      modelID: model!.modelID,
      variant: "",
    };

    await application.json("/api/preferences/quick-chat", {
      method: "PUT",
      body: JSON.stringify({
        workspaceId: workspace.id,
        model: modelConfig,
        useWorktree: false,
      }),
    });

    const chat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Codex control resume",
          workspaceId: workspace.id,
          model: modelConfig,
          useWorktree: false,
          autoApprovePermissions: false,
          baseBranch: git.branch,
        }),
      },
      201,
    )).data;

    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "List the workspaces available in Clanky.",
        attachments: [],
      }),
    });
    await waitForChatIdle(application, chat.config.id);
    await waitForToolResult(application, chat.config.id, workspaceName, 1);

    await application.restart({ env: environment });
    const reconnected = (await application.json<Chat>(
      `/api/chats/${chat.config.id}/reconnect`,
      { method: "POST", body: "{}" },
    )).data;
    expect(reconnected.state.status).toBe("idle");

    await application.json(`/api/chats/${chat.config.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message: "Wait for a steering instruction, then list the workspaces again after reconnecting.",
        attachments: [],
        clientId: crypto.randomUUID(),
      }),
    });
    await pollUntil(
      async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`)).data,
      (current) => current.state.status === "streaming",
      { description: "resumed control turn to become steerable", timeoutMs: 10_000 },
    );
    const steeredText = "Include the workspace name in the result of this active turn.";
    const queued = (await application.json<{ chat: Chat }>(`/api/chats/${chat.config.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: steeredText, attachments: [], clientId: crypto.randomUUID() }),
    })).data.chat;
    const input = queued.state.queuedMessages?.find((message) => message.content === steeredText);
    expect(input).toBeDefined();
    const steered = (await application.json<{ admission: { status: string } }>(
      `/api/chats/${chat.config.id}/queued-messages/${input!.id}/steer`,
      { method: "POST", body: "{}" },
    )).data;
    expect(steered.admission.status).toBe("accepted");
    await waitForChatIdle(application, chat.config.id);
    const resumedSnapshot = await waitForToolResult(
      application,
      chat.config.id,
      workspaceName,
      2,
    );
    expect(
      resumedSnapshot.transcript.messages.filter(
        (message) => message.role === "assistant" && message.content.includes(workspaceName),
      ),
    ).toHaveLength(2);
    expect(resumedSnapshot.transcript.messages.some(
      (message) => message.role === "assistant" && message.content.includes(steeredText),
    )).toBe(true);

    for (const [index, root] of ["/v1", "/openai/v1"].entries()) {
      const settings = (await application.json<Record<string, unknown>>("/api/voice/settings", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: voiceProvider.baseUrl.replace(/\/v1$/, root), apiKey: voiceProvider.apiKey,
          models: { transcription: "gpt-transcribe", text: "e2e-text" }, languageHints: ["en"],
          live: { useVoiceProvider: true, baseUrl: "", model: "gpt-live-1" },
        }),
      })).data;
      expect(JSON.stringify(settings)).not.toContain(voiceProvider.apiKey);
      const call = (await application.json<{ call: { id: string; status: string }; sdp: string }>(
        `/api/chats/${chat.config.id}/live-voice`,
        { method: "POST", body: JSON.stringify({ clientId: crypto.randomUUID(), sdp: "v=0\r\ns=browser-offer\r\n" }) },
        201,
      )).data;
      expect(call.call.status).toBe("active");
      expect(JSON.stringify(call)).not.toContain(voiceProvider.apiKey);
      await application.json(`/api/chats/${chat.config.id}/live-voice`, {
        method: "POST", body: JSON.stringify({ clientId: crypto.randomUUID(), sdp: "v=0\r\n" }),
      }, 409);
      await application.json(`/api/chats/not-this-chat/live-voice/${call.call.id}/heartbeat`, { method: "POST" }, 404);
      await waitForToolResult(application, chat.config.id, workspaceName, index + 3);
      await waitForChatIdle(application, chat.config.id);
      const closed = (await application.json<{ status: string; summarySaved: boolean; error: string | null }>(
        `/api/chats/${chat.config.id}/live-voice/${call.call.id}/close`, { method: "POST" },
      )).data;
      expect(closed).toMatchObject({ status: "closed", summarySaved: true, error: null });
      const snapshot = (await application.json<ChatSnapshot>(`/api/chats/${chat.config.id}/snapshot?full=1`)).data;
      expect(snapshot.transcript.logs.some((entry) => entry.details?.logKind === "voice_call" && entry.details.callId === call.call.id)).toBe(true);
      expect(snapshot.transcript.messages.filter((message) =>
        message.role === "user" && message.content.includes("Live steering request"))).toHaveLength(index + 1);
    }
    await application.restart({ env: environment });
    const persisted = (await application.json<ChatSnapshot>(`/api/chats/${chat.config.id}/snapshot?full=1`)).data;
    expect(persisted.transcript.logs.filter((entry) => entry.details?.logKind === "voice_call")).toHaveLength(2);
    await application.json(`/api/chats/${chat.config.id}/reconnect`, { method: "POST", body: "{}" });
    const openCall = async (scenario: string) => (await application.json<{ call: { id: string } }>(
      `/api/chats/${chat.config.id}/live-voice`,
      { method: "POST", body: JSON.stringify({ clientId: crypto.randomUUID(), sdp: `v=0\r\ns=${scenario}\r\n` }) }, 201,
    )).data.call.id;
    const holdId = await openCall("hold");
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`)).data.state.status,
      (status) => status === "streaming", { description: "Live-started work to become active", timeoutMs: 10_000 });
    await application.json(`/api/chats/${chat.config.id}/live-voice/${holdId}/close`, { method: "POST" });
    expect((await application.json<Chat>(`/api/chats/${chat.config.id}`)).data.state.status).toBe("streaming");
    const release = (await application.json<{ chat: Chat }>(`/api/chats/${chat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({ message: "Finish the work after the voice call ended.", attachments: [] }),
    })).data.chat.state.queuedMessages!.at(-1)!;
    await application.json(`/api/chats/${chat.config.id}/queued-messages/${release.id}/steer`, { method: "POST" });
    await waitForChatIdle(application, chat.config.id);

    const questionId = await openCall("question");
    const answered = await pollUntil(async () => (await application.json<Chat>(`/api/chats/${chat.config.id}`)).data,
      (current) => current.state.harness?.questions?.some((question) => question.status === "answered") === true,
      { description: "voice reply to reach the native question", timeoutMs: 10_000 });
    expect(answered.state.harness?.questions?.find((question) => question.status === "answered")?.answers).toEqual([["Names only"]]);
    await waitForChatIdle(application, chat.config.id);
    await application.json(`/api/chats/${chat.config.id}/live-voice/${questionId}/close`, { method: "POST" });
    const questionSnapshot = (await application.json<ChatSnapshot>(`/api/chats/${chat.config.id}/snapshot?full=1`)).data;
    expect(questionSnapshot.transcript.messages.some((message) => message.role === "assistant" && message.content.includes("Question answer: Names only"))).toBe(true);

    const cutId = await openCall("cut");
    const cut = await pollUntil(async () => (await application.json<{ status: string; error: string | null }>(
      `/api/chats/${chat.config.id}/live-voice/${cutId}/heartbeat`, { method: "POST" })).data,
      (state) => state.status === "failed", { description: "provider disconnect to surface a failed call", timeoutMs: 10_000 });
    expect(cut.error).not.toBeNull();
    expect((await application.json<Chat>(`/api/chats/${chat.config.id}`)).data.state.status).toBe("idle");
  } catch (error) {
    const diagnostics = await application.diagnostics();
    if (diagnostics.length > 0) {
      console.error(diagnostics);
    }
    throw error;
  } finally {
    await application.stop();
    try {
      if (voiceProvider) await stopVoiceProvider(voiceProvider);
    } finally {
      await application.cleanup();
    }
  }
});

test("Copilot shares ordinary Live and queued turns while control steering preserves tool provenance", async () => {
  const application = await E2EApplication.create();
  let voiceProvider: ManagedVoiceProvider | undefined;
  const sockets: WebSocket[] = [];
  try {
    const git = await createGitFixture(application.runDirectory);
    await installExternalNativeCopilotProvider(application.providerBinDirectory);
    voiceProvider = await startVoiceProvider(application.runDirectory);
    await application.start({ env: { NODE_EXTRA_CA_CERTS: voiceProvider.certificatePath } });
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
    const ordinaryId = await createChat("Ordinary Copilot Live");
    await application.json("/api/voice/settings", {
      method: "PUT", body: JSON.stringify({
        baseUrl: voiceProvider.baseUrl, apiKey: voiceProvider.apiKey,
        models: { transcription: "gpt-transcribe", text: "e2e-text" }, languageHints: ["en"],
        live: { useVoiceProvider: true, baseUrl: "", model: "gpt-live-1" },
      }),
    });
    const call = (await application.json<{ call: { id: string } }>(
      `/api/chats/${ordinaryId}/live-voice`, {
        method: "POST", body: JSON.stringify({ clientId: crypto.randomUUID(), sdp: "v=0\r\ns=ordinary\r\n" }),
      }, 201,
    )).data.call;
    await pollUntil(
      async () => (await application.json<ChatSnapshot>(`/api/chats/${ordinaryId}/snapshot?full=1`)).data,
      (snapshot) => snapshot.transcript.messages.some((message) => message.role === "assistant"
        && message.content.includes("Describe the ordinary Live chat request.")
        && message.content.includes("Clanky tools unavailable.")),
      {
        description: "ordinary Copilot chat to receive Live instructions without control tools", timeoutMs: 10_000,
        formatLastObserved: (snapshot) => JSON.stringify(snapshot.transcript.messages),
      },
    );
    await waitForChatIdle(application, ordinaryId);
    const closed = (await application.json<{ status: string; summarySaved: boolean }>(
      `/api/chats/${ordinaryId}/live-voice/${call.id}/close`, { method: "POST" },
    )).data;
    expect(closed).toMatchObject({ status: "closed", summarySaved: true });

    await application.json("/api/preferences/quick-chat", {
      method: "PUT", body: JSON.stringify({ workspaceId: workspace.id, model: modelConfig, useWorktree: false }),
    });
    const chatId = await createChat("Copilot control steering");
    const key = (await application.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "Copilot public realtime", scopes: ["*"] }),
    })).data.token;
    type UiAction = {
      type: string; actionId: string; chatId: string; clientId: string; turnId: string;
      action: { type: string; workspaceId: string };
    };
    const clients = [crypto.randomUUID(), crypto.randomUUID()];
    const actions: UiAction[][] = [[], []];
    const RuntimeWebSocket = WebSocket as {
      new(url: string | URL, protocols?: string | string[]): WebSocket;
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
      { description: "two Copilot browser clients to connect", timeoutMs: 5_000 });
    const send = async (message: string, clientId: string) => (await application.json<{ chat: Chat }>(
      `/api/chats/${chatId}/messages`,
      { method: "POST", body: JSON.stringify({ message, attachments: [], clientId }) },
    )).data.chat;
    const steer = async (message: string, clientId: string) => {
      const queued = await send(message, clientId);
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
    await send("Wait for a steering instruction, then open the workspace.", clients[0]!);
    await waitForActive();
    await steer("Change the request, but keep waiting.", clients[1]!);
    await steer("Finish the request and open the workspace.", clients[0]!);
    await waitForChatIdle(application, chatId);
    const mixed = await waitForToolResult(application, chatId, workspaceName, 1);
    expect(mixed.transcript.messages.some((message) => message.role === "assistant"
      && message.content.includes("Change the request, but keep waiting.")
      && message.content.includes("Finish the request and open the workspace.")
      && message.content.includes("control_client_unavailable"))).toBe(true);
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
        (value) => value?.chatId === chatId,
        { description: `queued turn to route its browser action to client ${index}`, timeoutMs: 10_000 });
      expect(action!.clientId).toBe(clients[index]!);
      await application.json(`/api/control/ui-actions/${action!.actionId}/ack`, {
        method: "POST", body: JSON.stringify({
          clientId: action!.clientId, chatId, turnId: action!.turnId,
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
    await pollUntil(() => sockets.map((socket) => socket.readyState),
      (states) => states.every((state) => state === WebSocket.CLOSED),
      { description: "Copilot browser clients to disconnect", timeoutMs: 5_000 });
    await application.stop();
    try {
      if (voiceProvider) await stopVoiceProvider(voiceProvider);
    } finally {
      await application.cleanup();
    }
  }
});
