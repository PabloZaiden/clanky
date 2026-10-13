import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture, gitStatus, type GitFixture } from "./support/git";
import { GLOBAL_LIVE_INTENT } from "./support/live-voice-provider";
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
  state: { status: string; harness?: { questions?: Array<{ requestId: string; status: string }> } };
}
interface Task {
  config: {
    id: string; name: string; workspaceId: string; prompt: string; baseBranch: string; model: Model;
    autoAcceptPlan: boolean; fullyAutonomous: boolean;
  };
  state: { status: string };
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

test("global Live discovers owned work, resumes its conversation and leaves delegated work usable", async () => {
  const application = await E2EApplication.create();
  const clients: VoiceClient[] = [];
  const repositories: GitFixture[] = [];
  let provider: ManagedVoiceProvider | undefined;
  let ssh: ManagedSshServer | undefined;
  let callId: string | undefined;
  try {
    for (const name of ["a", "b"]) {
      const root = join(application.runDirectory, name);
      await mkdir(root, { recursive: true });
      repositories.push(await createGitFixture(root));
    }
    const [repositoryA, repositoryB] = repositories as [GitFixture, GitFixture];
    const hostNote = "Use the chosen execution host's inventory when preparing workspace B.";
    await Bun.write(join(repositoryB.repositoryDirectory, GLOBAL_LIVE_INTENT.hostFile), hostNote);
    ssh = await startEphemeralSshServer({
      runDirectory: application.runDirectory, clientHomeDirectory: application.homeDirectory,
      providerBinDirectory: application.providerBinDirectory,
    });
    provider = await startVoiceProvider(application.runDirectory);
    const environment = { NODE_EXTRA_CA_CERTS: provider.certificatePath, SSH_AUTH_SOCK: ssh.agentSocket };
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
        name: GLOBAL_LIVE_INTENT.sourceTask, workspaceId: workspaceA.id, prompt: sourcePrompt, draft: true,
      }),
    }, 201)).data;
    const sourceChat = (await application.json<Chat>("/api/chats", {
      method: "POST", body: JSON.stringify({
        name: GLOBAL_LIVE_INTENT.sourceChat, workspaceId: workspaceA.id,
        model, baseBranch: repositoryA.branch, useWorktree: false, autoApprovePermissions: false,
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
    expect((await application.json<Task>(`/api/tasks/${sourceTask.config.id}`)).data)
      .toMatchObject({ config: { prompt: sourcePrompt }, state: { status: "draft" } });
    const taskDecision = await visualDecision({
      application, client, callId, approved: true,
      async inspect(event) {
        expect((await application.json<Task[]>("/api/tasks")).data.map((task) => task.config.id))
          .toEqual([sourceTask.config.id]);
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
    await pollUntil(async () => (await application.json<Chat>(`/api/chats/${createdChat.config.id}`)).data.state.status,
      (status) => status === "idle",
      { description: "remembered delegated work to finish after resumed voice answers it", timeoutMs: 10_000 });
    expect((await application.json<LiveState>(`/api/voice/live/${callId}/close`, {
      method: "POST", body: JSON.stringify({ clientId: other.id }),
    })).data.status).toBe("closed");
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
            await application.cleanup();
          }
        }
      }
    }
  }
});
