import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture, gitStatus, type GitFixture } from "./support/git";
import { GLOBAL_LIVE_INTENT } from "./support/live-voice-provider";
import { installExternalNativeOpenCodeProvider } from "./support/provider";
import { pollUntil } from "./support/polling";
import { readProcessDiagnostics } from "./support/process";
import {
  startEphemeralSshServer, stopEphemeralSshServer, type ManagedSshServer,
} from "./support/ssh-server";
import {
  createFixtureLiveOffer, startVoiceProvider, stopVoiceProvider, type ManagedVoiceProvider,
} from "./support/voice-provider";

interface Model { providerID: string; modelID: string; variant: string }
interface Workspace { id: string; name: string }
interface Chat {
  config: { id: string; name: string; workspaceId: string };
  state: {
    status: string;
    queuedMessages?: Array<{ id: string; content: string }>;
    harness?: {
      questions?: Array<{ requestId: string; status: string }>;
      inputs?: Array<{ admission: { inputId: string; status: string } }>;
    };
  };
}
interface Task {
  config: {
    id: string; name: string; workspaceId: string; prompt: string; baseBranch: string; model: Model;
    autoAcceptPlan: boolean; fullyAutonomous: boolean;
  };
  state: { status: string; planMode?: { isPlanReady: boolean } };
}
interface Snapshot { transcript: { messages: Array<{ role: string; content: string }> } }
interface CreationContext {
  ready: boolean;
  defaults: Record<string, unknown>;
}
interface LiveState { id: string; status: string; error: string | null }
interface UiAction {
  type: "control.ui_action";
  actionId: string;
  source: { kind: "live_voice"; callId: string; requestId: string };
  clientId: string;
  expiresAt: number;
  action: {
    type: string;
    taskId?: string;
    chatId?: string;
    serverId?: string;
    requestId?: string;
    confirmation?: { requestId: string; description: string; expiresAt: number };
  };
}

class VoiceClient {
  readonly id = crypto.randomUUID();
  readonly actions: UiAction[] = [];
  readonly socket: WebSocket;
  context = {
    revision: 0,
    route: { view: "home" } as Record<string, string>,
    planningPreferences: { autoAcceptPlan: false, fullyAutonomous: false },
  };

  constructor(private readonly application: E2EApplication, apiKey: string) {
    const RuntimeWebSocket = WebSocket as {
      new(url: string | URL, protocols?: string | string[]): WebSocket;
      new(url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
    };
    this.socket = new RuntimeWebSocket(`${application.baseUrl.replace("http:", "ws:")}/api/ws?clientId=${this.id}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Origin: application.baseUrl },
    });
    this.socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.event?.type === "control.ui_action") {
        this.actions.push(frame.event as UiAction);
        this.actions.splice(0, Math.max(0, this.actions.length - 32));
      }

    };
  }

  async next(type: string): Promise<UiAction> {
    return (await pollUntil(
      () => this.actions.find((event) => event.action.type === type),
      (event) => event !== undefined,
      { description: `originating Live client to receive ${type}`, timeoutMs: 5_000,
        formatLastObserved: () => JSON.stringify(this.actions) },
    ))!;
  }

  async ack(event: UiAction, outcome: Record<string, unknown>): Promise<void> {
    expect(event.clientId).toBe(this.id);
    expect(event.source.kind).toBe("live_voice");
    await this.application.json(`/api/control/ui-actions/${event.actionId}/ack`, {
      method: "POST", body: JSON.stringify({ clientId: this.id, source: event.source, outcome }),
    });
    this.actions.splice(this.actions.indexOf(event), 1);
  }

  async open(type: "open_task" | "open_chat", id: string): Promise<void> {
    const event = await this.next(type);
    expect(type === "open_task" ? event.action.taskId : event.action.chatId).toBe(id);
    this.context = {
      ...this.context, revision: this.context.revision + 1,
      route: type === "open_task" ? { view: "task", taskId: id } : { view: "chat", chatId: id },
    };
    await this.ack(event, { status: "opened", action: event.action });
  }
}

async function sshCredential(application: E2EApplication, serverId: string): Promise<string> {
  const publicKey = (await application.json<{
    publicKey: string; algorithm: string; fingerprint: string; version: number;
  }>(`/api/ssh-servers/${serverId}/public-key`)).data;
  const key = await crypto.subtle.importKey("spki", Uint8Array.from(Buffer.from(
    publicKey.publicKey.replace(/-----[^-]+-----|\s/g, ""), "base64",
  )).buffer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  // An empty password explicitly selects this fixture's real SSH key/agent.
  const ciphertext = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new Uint8Array());
  return (await application.json<{ credentialToken: string }>(`/api/ssh-servers/${serverId}/credentials`, {
    method: "POST", body: JSON.stringify({
      encryptedCredential: {
        algorithm: publicKey.algorithm, fingerprint: publicKey.fingerprint,
        version: publicKey.version, ciphertext: Buffer.from(ciphertext).toString("base64"),
      },
    }),
  }, 201)).data.credentialToken;
}

async function visualDecision(options: {
  application: E2EApplication; client: VoiceClient; callId: string;
  approved: boolean;
  inspect?: (event: UiAction) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { application, client, callId, approved, inspect } = options;
  const event = await client.next("confirm_operation");
  expect(event.source.callId).toBe(callId);
  await inspect?.(event);
  await client.ack(event, { status: "presented" });
  return (await application.json<Record<string, unknown>>(
    `/api/voice/live/${callId}/confirmations/${event.action.confirmation!.requestId}`,
    { method: "POST", body: JSON.stringify({ clientId: client.id, approved }) },
  )).data;
}

test("global Live operates owned recent and waiting work, resumes its conversation and leaves delegated work usable", async () => {
  const application = await E2EApplication.create();
  const clients: VoiceClient[] = [];
  const repositories: GitFixture[] = [];
  let provider: ManagedVoiceProvider | undefined;
  let ssh: ManagedSshServer | undefined;
  let callId: string | undefined;
  let streamingReleasePath: string | undefined;
  let steeringReleasePath: string | undefined;
  try {
    await installExternalNativeOpenCodeProvider(application.providerBinDirectory);
    for (const name of ["a", "b"]) {
      const root = join(application.runDirectory, name);
      await mkdir(root, { recursive: true });
      repositories.push(await createGitFixture(root));
    }
    const [repositoryA, repositoryB] = repositories as [GitFixture, GitFixture];
    const statusReleasePath = join(repositoryA.repositoryDirectory, ".clanky-e2e-voice-status-release");
    streamingReleasePath = statusReleasePath;
    const hostNote = "Use the chosen execution host's inventory when preparing workspace B.";
    await Bun.write(join(repositoryB.repositoryDirectory, GLOBAL_LIVE_INTENT.hostFile), hostNote);
    ssh = await startEphemeralSshServer({
      runDirectory: application.runDirectory, clientHomeDirectory: application.homeDirectory,
      providerBinDirectory: application.providerBinDirectory,
    });
    provider = await startVoiceProvider(application.runDirectory);
    const environment = {
      NODE_EXTRA_CA_CERTS: provider.certificatePath, SSH_AUTH_SOCK: ssh.agentSocket, CLANKY_LOG_LEVEL: "info",
    };
    await application.start({ env: environment });
    const local = (await application.json<Array<{ ref: Record<string, string> }>>("/api/execution-hosts"))
      .data.find((host) => host.ref["kind"] === "local")!;
    const workspaces: Workspace[] = [];
    for (const [index, repository] of repositories.entries()) {
      workspaces.push((await application.json<Workspace>("/api/workspaces", {
        method: "POST", body: JSON.stringify({
          name: index === 0 ? GLOBAL_LIVE_INTENT.workspaceA : GLOBAL_LIVE_INTENT.workspaceB,
          directory: repository.repositoryDirectory, executionHost: local.ref,
          serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
        }),
      }, 201)).data);
    }
    const [workspaceA, workspaceB] = workspaces as [Workspace, Workspace];
    const steeringDirectory = join(application.runDirectory, "steering");
    await mkdir(steeringDirectory, { recursive: true });
    steeringReleasePath = join(steeringDirectory, ".clanky-e2e-voice-end-release");
    const steeringWorkspace = (await application.json<Workspace>("/api/workspaces", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.steeringWorkspace, directory: steeringDirectory,
        executionHost: local.ref, workspaceType: "directory", allowWorktrees: false,
        serverSettings: { agent: { adapter: "opencode2", provider: "opencode" } },
      }),
    }, 201)).data;
    const steeringModelOption = (await application.json<Array<{
      providerID: string; modelID: string; variant?: string; connected: boolean;
    }>>(`/api/models?workspaceId=${steeringWorkspace.id}`)).data.find(
      (entry) => entry.connected && entry.modelID === "e2e-opencode-model",
    );
    if (!steeringModelOption) throw new Error("The external OpenCode steering model is unavailable.");
    const steeringModel = {
      providerID: steeringModelOption.providerID,
      modelID: steeringModelOption.modelID,
      variant: steeringModelOption.variant ?? "",
    };
    const steeringChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.steeringChat, workspaceId: steeringWorkspace.id,
        model: steeringModel, useWorktree: false,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${steeringChat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({ message: "Wait for steering.", attachments: [] }),
    });
    await pollUntil(async () => (
      await application.json<Chat>(`/api/chats/${steeringChat.config.id}`)
    ).data.state.status,
    (status) => status === "streaming",
    { description: "OpenCode chat to accept native Voice steering", timeoutMs: 10_000 });
    const queuedResponse = await application.json<{ chat: Chat }>(
      `/api/chats/${steeringChat.config.id}/messages`, {
        method: "POST", body: JSON.stringify({ message: GLOBAL_LIVE_INTENT.steeringMessage, attachments: [] }),
      },
    );
    const queuedMessageId = queuedResponse.data.chat.state.queuedMessages
      ?.find((message) => message.content === GLOBAL_LIVE_INTENT.steeringMessage)?.id;
    if (!queuedMessageId) throw new Error("The OpenCode steering message was not queued.");
    const server = (await application.json<{ config: { id: string } }>("/api/ssh-servers", {
      method: "POST", body: JSON.stringify({
        name: "Live SSH host", address: "127.0.0.1", port: ssh.port, username: ssh.username,
        repositoriesBasePath: repositoryB.repositoryDirectory,
      }),
    }, 201)).data;
    const credentialToken = await sshCredential(application, server.config.id);
    await application.json("/api/voice/settings", {
      method: "PUT", body: JSON.stringify({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, languageHints: ["en"],
        models: { transcription: "gpt-transcribe", text: "e2e-text" },
        live: { useVoiceProvider: true, baseUrl: "", model: "gpt-live-1" },
      }),
    });
    const key = (await application.json<{ token: string }>("/api/api-keys", {
      method: "POST", body: JSON.stringify({ name: "Global Live clients", scopes: ["*"] }),
    })).data.token;
    clients.push(new VoiceClient(application, key), new VoiceClient(application, key));
    await pollUntil(() => clients.map((client) => client.socket.readyState),
      (states) => states.every((state) => state === WebSocket.OPEN),
      { description: "Live originating and other browser tabs to connect", timeoutMs: 5_000 });
    const [client, other] = clients as [VoiceClient, VoiceClient];
    const startBody = { clientId: client.id, context: client.context, sdp: createFixtureLiveOffer("global-product") };
    const started = (await application.json<{ call: LiveState; sdp: string }>("/api/voice/live", {
      method: "POST", apiKey: key, body: JSON.stringify(startBody),
    }, 201)).data;
    callId = started.call.id;
    expect(started.call.status).toBe("active");
    expect(started.sdp).toContain("v=0");
    const initialContext = await client.next("get_context");
    expect(initialContext.source.callId).toBe(callId);
    await application.json("/api/voice/live", {
      method: "POST", body: JSON.stringify({ ...startBody, clientId: other.id }),
    }, 409);

    const available = (await application.json<Array<Model & { connected: boolean }>>(
      `/api/models?workspaceId=${workspaceB.id}`,
    )).data.find((model) => model.connected)!;
    const model = { providerID: available.providerID, modelID: available.modelID, variant: available.variant ?? "" };
    await application.json("/api/preferences/last-model", { method: "PUT", body: JSON.stringify(model) });
    await application.json("/api/preferences/last-cheap-model", {
      method: "PUT", body: JSON.stringify({ mode: "same-as-task" }),
    });
    const creation = (await application.json<CreationContext>(
      `/api/workspaces/${workspaceA.id}/task-creation-context`,
    )).data;
    expect(creation.ready).toBe(true);
    const sourcePrompt = "Carry the existing workspace inventory into the explicitly chosen workspace B.";
    const sourceTask = (await application.json<Task>("/api/tasks", {
      method: "POST", body: JSON.stringify({
        ...creation.defaults, ...client.context.planningPreferences, model,
        name: GLOBAL_LIVE_INTENT.sourceTask, workspaceId: workspaceA.id, prompt: sourcePrompt, draft: false,
      }),
    }, 201)).data;
    await pollUntil(async () => (await application.json<Task>(`/api/tasks/${sourceTask.config.id}`)).data.state,
      (state) => state.status === "planning" && state.planMode?.isPlanReady === true,
      { description: "source task plan awaiting the user's review", timeoutMs: 10_000 });
    const createVoiceStatusTask = async (name: string, prompt: string): Promise<Task> => (
      await application.json<Task>("/api/tasks", {
        method: "POST", body: JSON.stringify({
          ...creation.defaults, ...client.context.planningPreferences, model,
          name, workspaceId: workspaceA.id, prompt, draft: false, autoAcceptPlan: true,
        }),
      }, 201)
    ).data;
    const completedTask = await createVoiceStatusTask(
      GLOBAL_LIVE_INTENT.completedTask,
      "Complete the deterministic task used to report a Voice status category.",
    );
    await pollUntil(async () => (await application.json<Task>(`/api/tasks/${completedTask.config.id}`)).data.state,
      (state) => state.status === "completed",
      { description: "completed task for Voice status category coverage", timeoutMs: 10_000 });
    const failedTask = await createVoiceStatusTask(
      GLOBAL_LIVE_INTENT.failedTask,
      "[provider-error] Surface a deterministic provider failure for Voice status coverage.",
    );
    await pollUntil(async () => (await application.json<Task>(`/api/tasks/${failedTask.config.id}`)).data.state,
      (state) => state.status === "failed",
      { description: "failed task for Voice status category coverage", timeoutMs: 10_000 });

    const sourceChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.sourceChat, workspaceId: workspaceA.id,
        model, baseBranch: repositoryA.branch, useWorktree: false,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${sourceChat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({ message: "Describe the current workspace inventory.", attachments: [] }),
    });
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${sourceChat.config.id}`)).data.state.status,
      (status) => status === "idle",
      { description: "source conversation answer to become readable", timeoutMs: 10_000 });
    const sourceAnswer = (await application.json<Snapshot>(`/api/chats/${sourceChat.config.id}/snapshot`))
      .data.transcript.messages.findLast((message) => message.role === "assistant")!.content;
    const streamingChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.streamingChat, workspaceId: workspaceA.id,
        model, baseBranch: repositoryA.branch, useWorktree: false,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${streamingChat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({
        message: "[voice-status-stream] Hold this conversation while Voice reports active chats.",
        attachments: [],
      }),
    });
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${streamingChat.config.id}`)).data.state.status,
      (status) => status === "streaming",
      { description: "conversation held in streaming state for Voice status reporting", timeoutMs: 10_000 });
    const doneChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.doneChat, workspaceId: workspaceA.id,
        model, baseBranch: repositoryA.branch, useWorktree: false,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${doneChat.config.id}/done`, { method: "POST" });
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${doneChat.config.id}`)).data.state.status,
      (status) => status === "done",
      { description: "completed conversation for Voice status category coverage", timeoutMs: 5_000 });
    const errorChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.errorChat, workspaceId: workspaceA.id,
        model, baseBranch: repositoryA.branch, useWorktree: false,
      }),
    }, 201)).data;
    await application.json(`/api/chats/${errorChat.config.id}/messages`, {
      method: "POST", body: JSON.stringify({
        message: "[chat-provider-error] Fail this conversation for Voice status category coverage.",
        attachments: [],
      }),
    });
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${errorChat.config.id}`)).data.state.status,
      (status) => status === "failed",
      { description: "failed conversation for Voice status category coverage", timeoutMs: 10_000 });
    await client.ack(initialContext, { status: "context", context: client.context });

    const credential = await client.next("request_ssh_credential");
    expect(credential.action.serverId).toBe(server.config.id);
    await client.ack(credential, { status: "presented" });
    await application.json(`/api/voice/live/${callId}/credentials/${credential.action.requestId}`, {
      method: "POST", body: JSON.stringify({ clientId: client.id, credentialToken }),
    });
    await visualDecision({
      application, client, callId, approved: false,
    });
    const steeringState = (await application.json<Chat>(`/api/chats/${steeringChat.config.id}`)).data.state;
    expect(steeringState.status).toBe("streaming");
    expect(steeringState.queuedMessages?.some((message) => message.id === queuedMessageId)).toBe(false);
    expect(steeringState.harness?.inputs?.find(
      (entry) => entry.admission.inputId === queuedMessageId,
    )?.admission.status).toBe("accepted");
    await Bun.write(statusReleasePath, "released");
    await pollUntil(async () => (
      await application.json<Chat>(`/api/chats/${streamingChat.config.id}`)
    ).data.state.status,
    (status) => status === "idle",
    { description: "streaming conversation to finish after Voice status report", timeoutMs: 10_000 });
    await Bun.file(statusReleasePath).delete();
    streamingReleasePath = undefined;
    expect((await application.json<Task>(`/api/tasks/${sourceTask.config.id}`)).data)
      .toMatchObject({ config: { prompt: sourcePrompt }, state: { status: "planning", planMode: { isPlanReady: true } } });
    const taskContext = await client.next("get_context");
    await client.ack(taskContext, { status: "context", context: client.context });
    const taskDecision = await visualDecision({
      application, client, callId, approved: true,
      async inspect(event) {
        expect((await application.json<Task[]>("/api/tasks")).data.map((task) => task.config.id))
          .toContain(sourceTask.config.id);
        await application.json(`/api/voice/live/${callId}/confirmations/${event.action.confirmation!.requestId}`, {
          method: "POST", body: JSON.stringify({ clientId: other.id, approved: true }),
        }, 404);
      },
    });
    const taskReceipt = taskDecision["data"] as { id: string };
    const createdTask = (await application.json<Task>(`/api/tasks/${taskReceipt.id}`)).data;
    expect(createdTask).toMatchObject({
      config: {
        workspaceId: workspaceB.id, baseBranch: repositoryB.branch, model,
        autoAcceptPlan: false, fullyAutonomous: false,
      },
      state: { status: "draft" },
    });
    expect(createdTask.config.prompt).toContain(sourcePrompt);
    expect(createdTask.config.prompt).toContain(sourceAnswer);
    expect(createdTask.config.prompt).toContain(hostNote);
    await client.open("open_task", createdTask.config.id);
    expect((await application.json<LiveState>(`/api/voice/live/${callId}`)).data.status).toBe("active");
    await application.json(`/api/voice/live/${callId}/heartbeat`, {
      method: "POST", body: JSON.stringify({ clientId: client.id, context: client.context }),
    });
    const chatDecision = await visualDecision({
      application, client, callId, approved: true,
    });
    const chatReceipt = chatDecision["data"] as { id: string };
    const createdChat = (await application.json<Chat>(`/api/chats/${chatReceipt.id}`)).data;
    await client.open("open_chat", createdChat.config.id);
    const fresh = await client.next("get_context");
    await client.ack(fresh, { status: "context", context: client.context });
    expect(client.context.route).toEqual({ view: "chat", chatId: createdChat.config.id });
    expect(other.context.route).toEqual({ view: "home" });
    const waiting = (await application.json<Chat>(`/api/chats/${createdChat.config.id}`)).data;
    expect(waiting.state.status).toBe("waiting");
    const closed = (await application.json<LiveState>(`/api/voice/live/${callId}/close`, {
      method: "POST", body: JSON.stringify({ clientId: client.id }),
    })).data;
    expect(closed.status).toBe("closed");
    expect((await application.json<Chat>(`/api/chats/${createdChat.config.id}`)).data.state.status).toBe("waiting");
    const resumed = (await application.json<{ call: LiveState }>("/api/voice/live", {
      method: "POST", apiKey: key, body: JSON.stringify({
        clientId: other.id, context: other.context, sdp: createFixtureLiveOffer("global-resume"),
      }),
    }, 201)).data;
    callId = resumed.call.id;
    await other.open("open_chat", createdChat.config.id);
    await provider.waitForGoodbyeBarrier();
    expect((await application.json<LiveState>(`/api/voice/live/${callId}`)).data.status).toBe("active");
    provider.releaseGoodbyeBarrier();
    const ended = await pollUntil(
      async () => (await application.json<LiveState>(`/api/voice/live/${callId}`)).data,
      (state) => state.status === "closed" || state.status === "failed",
      { description: "Voice call to close after the model handles the user's farewell", timeoutMs: 10_000 },
    );
    expect(ended.status).toBe("closed");
    expect((await application.json<Chat>(`/api/chats/${steeringChat.config.id}`)).data.state.status)
      .toBe("streaming");
    await Bun.write(steeringReleasePath, "released");
    await pollUntil(async () => (
      await application.json<Chat>(`/api/chats/${steeringChat.config.id}`)
    ).data.state.status,
    (status) => status === "idle",
    { description: "steered OpenCode work to finish after Voice closes", timeoutMs: 10_000 });
    const steeringSnapshot = (await application.json<Snapshot>(
      `/api/chats/${steeringChat.config.id}/snapshot?full=1`,
    )).data;
    expect(steeringSnapshot.transcript.messages.filter(
      (message) => message.role === "user" && message.content === GLOBAL_LIVE_INTENT.steeringMessage,
    )).toHaveLength(1);
    expect(steeringSnapshot.transcript.messages.some(
      (message) => message.role === "assistant" && message.content.includes(GLOBAL_LIVE_INTENT.steeringMessage),
    )).toBe(true);
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${createdChat.config.id}`)).data.state.status,
      (status) => status === "idle",
      { description: "remembered delegated work to finish after resumed voice answers it", timeoutMs: 10_000 });
    expect(await Bun.file(join(repositoryB.repositoryDirectory, "e2e-provider-change.txt")).text())
      .toContain("created by the external ACP provider");
    for (const tab of clients) tab.socket.close();
    await pollUntil(() => clients.map((tab) => tab.socket.readyState),
      (states) => states.every((state) => state === WebSocket.CLOSED),
      { description: "Live browser clients to disconnect", timeoutMs: 5_000 });
    await application.restart({ env: environment });
    expect((await application.json<Task>(`/api/tasks/${createdTask.config.id}`)).data)
      .toMatchObject({ config: { workspaceId: workspaceB.id, name: GLOBAL_LIVE_INTENT.createdTask }, state: { status: "draft" } });
    expect((await application.json<Chat>(`/api/chats/${createdChat.config.id}`)).data)
      .toMatchObject({ config: { workspaceId: workspaceB.id, name: GLOBAL_LIVE_INTENT.createdChat }, state: { status: "idle" } });
    expect((await application.json<Snapshot>(`/api/chats/${createdChat.config.id}/snapshot`))
      .data.transcript.messages.some((message) => message.role === "user" && message.content.includes(sourcePrompt))).toBe(true);
  } catch (error) {
    try {
      console.error(await application.diagnostics());
      if (provider) console.error(`External Live peer: ${provider.diagnostics()}`);
      if (ssh) console.error(await readProcessDiagnostics(ssh.process));
      for (const repository of repositories) console.error(`Git ${repository.repositoryDirectory}: ${await gitStatus(repository)}`);
      if (callId && application.isRunning) {
        console.error(`Last public Live state: ${await (await application.request(`/api/voice/live/${callId}`)).text()}`);
      }
    } catch (diagnosticError) {
      console.error(`Failure diagnostics could not be completed: ${String(diagnosticError)}`);
    }
    throw error;
  } finally {
    if (streamingReleasePath) await Bun.write(streamingReleasePath, "released");
    if (steeringReleasePath) await Bun.write(steeringReleasePath, "released");
    for (const client of clients) client.socket.close();
    try {
      await pollUntil(() => clients.map((client) => client.socket.readyState),
        (states) => states.every((state) => state === WebSocket.CLOSED),
        { description: "Live browser client teardown", timeoutMs: 5_000 });
    } finally {
      try {
        await application.stop();
      } finally {
        try {
          if (ssh) await stopEphemeralSshServer(ssh);
        } finally {
          try {
            if (provider) await stopVoiceProvider(provider);
          } finally {
            if (streamingReleasePath && await Bun.file(streamingReleasePath).exists()) {
              await Bun.file(streamingReleasePath).delete();
            }
            await application.cleanup();
          }
        }
      }
    }
  }
});
