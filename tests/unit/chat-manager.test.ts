import { afterEach, describe, expect, test } from "bun:test";
import { ChatManager } from "../../src/core/chat-manager";
import { backendManager } from "../../src/core/backend-manager";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { loadChat } from "../../src/persistence/chats";
import type { ChatEvent } from "../../src/types";
import type { ModelInfo } from "../../src/types/api";
import type {
  AgentEvent,
  AgentResponse,
  AgentSession,
  Backend,
  BackendConnectionConfig,
  ConnectionInfo,
  CreateSessionOptions,
  PromptInput,
} from "../../src/backends/types";
import { createEventStream, type EventStream } from "../../src/utils/event-stream";
import { setupTestContext, teardownTestContext, testModelFields, testWorkspaceId, type TestContext } from "../setup";

let context: TestContext | undefined;

async function waitForChat(
  chatId: string,
  predicate: (chat: NonNullable<Awaited<ReturnType<typeof loadChat>>>) => boolean,
  timeoutMs = 5000,
): Promise<NonNullable<Awaited<ReturnType<typeof loadChat>>>> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const chat = await loadChat(chatId);
    if (chat && predicate(chat)) {
      return chat;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const lastChat = await loadChat(chatId);
  throw new Error(`Timed out waiting for chat condition. Last state: ${JSON.stringify(lastChat?.state)}`);
}

class InterruptRaceBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly subscriptions = new Map<string, {
    stream: EventStream<AgentEvent>;
    push: (event: AgentEvent) => void;
    end: () => void;
  }>();
  private readonly pendingPrompts = new Map<string, {
    reject: (error: Error) => void;
  }>();

  async connect(config: BackendConnectionConfig): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `interrupt-race-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "unused",
      parts: [{ type: "text", text: "unused" }],
    };
  }

  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    const promptText = prompt.parts
      .filter((part): part is Extract<PromptInput["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(" ");

    if (promptText.includes("follow-up")) {
      setTimeout(() => {
        subscription.push({
          type: "message.start",
          messageId: `msg-${crypto.randomUUID()}`,
        });
        subscription.push({
          type: "message.delta",
          content: "Second response after interrupt",
        });
        subscription.push({
          type: "message.complete",
          content: "Second response after interrupt",
        });
        subscription.end();
      }, 0);
      return;
    }

    return await new Promise<void>((_resolve, reject) => {
      this.pendingPrompts.set(sessionId, {
        reject: (error: Error) => reject(error),
      });
    });
  }

  async abortSession(sessionId: string): Promise<void> {
    const pendingPrompt = this.pendingPrompts.get(sessionId);
    if (!pendingPrompt) {
      return;
    }
    this.pendingPrompts.delete(sessionId);
    setTimeout(() => {
      pendingPrompt.reject(new Error("Operation cancelled by user"));
    }, 0);
  }

  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();
    const subscription = { stream, push, end };
    this.subscriptions.set(sessionId, subscription);

    return {
      next: () => stream.next(),
      close: () => {
        stream.close();
        end();
        if (this.subscriptions.get(sessionId) === subscription) {
          this.subscriptions.delete(sessionId);
        }
      },
    };
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {}

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {}

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string): Promise<void> {}

  abortAllSubscriptions(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.stream.close();
      subscription.end();
    }
    this.subscriptions.clear();
  }

  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connected
      ? {
          baseUrl: "http://interrupt-race-backend",
          authHeaders: {},
        }
      : null;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async getModels(_directory: string): Promise<ModelInfo[]> {
    return [];
  }
}

class UnsupportedInterruptBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly subscriptions = new Map<string, {
    stream: EventStream<AgentEvent>;
    push: (event: AgentEvent) => void;
    end: () => void;
  }>();

  async connect(config: BackendConnectionConfig): Promise<void> {
    this.connected = true;
    this.directory = config.directory;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.directory = "";
  }

  isConnected(): boolean {
    return this.connected;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const session: AgentSession = {
      id: `unsupported-interrupt-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "unused",
      parts: [{ type: "text", text: "unused" }],
    };
  }

  async sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    const promptText = prompt.parts
      .filter((part): part is Extract<PromptInput["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(" ");

    if (promptText.includes("follow-up")) {
      setTimeout(() => {
        subscription.push({
          type: "message.start",
          messageId: `msg-${crypto.randomUUID()}`,
        });
        subscription.push({
          type: "message.delta",
          content: "Second response after unsupported interrupt",
        });
        subscription.push({
          type: "message.complete",
          content: "Second response after unsupported interrupt",
        });
        subscription.end();
      }, 20);
      return;
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: `msg-${crypto.randomUUID()}`,
      });
      subscription.push({
        type: "message.delta",
        content: "First response that should be discarded after interrupt",
      });
      subscription.push({
        type: "message.complete",
        content: "First response that should be discarded after interrupt",
      });
      subscription.end();
    }, 80);
  }

  async abortSession(_sessionId: string): Promise<void> {}

  async subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>> {
    const { stream, push, end } = createEventStream<AgentEvent>();
    const subscription = { stream, push, end };
    this.subscriptions.set(sessionId, subscription);

    return {
      next: () => stream.next(),
      close: () => {
        stream.close();
        end();
        if (this.subscriptions.get(sessionId) === subscription) {
          this.subscriptions.delete(sessionId);
        }
      },
    };
  }

  async replyToPermission(_requestId: string, _response: string): Promise<void> {}

  async replyToQuestion(_requestId: string, _answers: string[][]): Promise<void> {}

  async setConfigOption(_sessionId: string, _configId: string, _value: string) {
    return [];
  }

  async setSessionModel(_sessionId: string, _modelId: string): Promise<void> {}

  abortAllSubscriptions(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.stream.close();
      subscription.end();
    }
    this.subscriptions.clear();
  }

  getSdkClient(): null {
    return null;
  }

  getDirectory(): string {
    return this.directory;
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connected
      ? {
          baseUrl: "http://unsupported-interrupt-backend",
          authHeaders: {},
        }
      : null;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async getModels(_directory: string): Promise<ModelInfo[]> {
    return [];
  }
}

type ChatManagerInternals = {
  activeStreamGenerations: Map<string, number>;
  activeStreams: Map<string, { generation: number }>;
};

describe("ChatManager", () => {
  afterEach(async () => {
    if (context) {
      await teardownTestContext(context);
      context = undefined;
    }
  });

  test("streams chat responses and persists assistant messages", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Runtime Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    const started = await manager.sendMessage(chat.config.id, {
      message: "Say hello",
    });

    expect(started.state.status).toBe("streaming");

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle" && current.state.messages.some((message) => message.role === "assistant"),
    );

    expect(completed.state.session?.id).toBeString();
    expect(completed.state.worktree?.originalBranch).toBeString();
    expect(completed.state.worktree?.workingBranch).toContain("chat-runtime-chat-");
    expect(completed.state.worktree?.worktreePath).toBe(`${context.workDir}/.ralph-worktrees/${chat.config.id}`);
    expect(context.mockBackend?.getDirectory()).toBe(completed.state.worktree?.worktreePath);
    expect(
      await context.git.worktreeExists(
        context.workDir,
        `${context.workDir}/.ralph-worktrees/${chat.config.id}`,
      ),
    ).toBe(true);
    expect(completed.state.messages.map((message) => message.content)).toEqual([
      "Say hello",
      "Hello from the chat backend",
    ]);
  });

  test("emits chat.status events for starting, streaming, and idle transitions", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const events: ChatEvent[] = [];
    const emitter = new SimpleEventEmitter<ChatEvent>();
    emitter.subscribe((event) => {
      events.push(event);
    });

    const manager = new ChatManager(emitter);
    const chat = await manager.createChat({
      name: "Status Events Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Say hello",
    });

    await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    const statuses = events
      .filter((event): event is Extract<ChatEvent, { type: "chat.status" }> => event.type === "chat.status")
      .map((event) => event.status);

    expect(statuses).toEqual(expect.arrayContaining(["starting", "streaming", "idle"]));
  });

  test("recreates a missing persisted session during reconnect", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Recovered response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Reconnect Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    const firstRun = await manager.sendMessage(chat.config.id, {
      message: "Create a session",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const sessionId = completed.state.session?.id;

    expect(sessionId).toBeString();
    await context.mockBackend?.deleteSession(sessionId!);

    const reconnected = await manager.reconnectSession(firstRun.config.id);
    expect(reconnected).not.toBeNull();
    expect(reconnected?.state.status).toBe("idle");
    expect(reconnected?.state.session?.id).not.toBe(sessionId);
    expect(reconnected?.state.error).toBeUndefined();
    expect(await context.mockBackend?.getSession(sessionId!)).toBeNull();
  });

  test("marks reconnect as failed when backend session lookup errors unexpectedly", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Recovered response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Reconnect Error Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create a session",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    expect(completed.state.session?.id).toBeString();

    context.mockBackend?.failNextGetSession("backend session lookup exploded");

    await expect(manager.reconnectSession(chat.config.id)).rejects.toThrow("backend session lookup exploded");

    const failed = await waitForChat(chat.config.id, (current) => current.state.status === "failed");
    expect(failed.state.error?.message).toBe("Error: backend session lookup exploded");
  });

  test("auto-reconnects on send when the persisted session is missing", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["First response", "Recovered response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Auto Reconnect Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create a session",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const sessionId = completed.state.session?.id;

    expect(sessionId).toBeString();
    await context.mockBackend?.deleteSession(sessionId!);

    const restarted = await manager.sendMessage(chat.config.id, {
      message: "Recover and continue",
    });
    expect(restarted.state.status).toBe("streaming");

    const recovered = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle" && current.state.messages.some((message) => message.content === "Recovered response"),
    );

    expect(recovered.state.session?.id).toBeString();
    expect(recovered.state.session?.id).not.toBe(sessionId);
    expect(recovered.state.error).toBeUndefined();
  });

  test("marks chats as failed when recreating a missing session fails during send", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["First response", "Recovered response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Recreate Failure Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create a session",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const sessionId = completed.state.session?.id;

    expect(sessionId).toBeString();
    await context.mockBackend?.deleteSession(sessionId!);
    context.mockBackend?.failNextCreateSession("session recreation exploded");

    await expect(manager.sendMessage(chat.config.id, {
      message: "Recover and continue",
    })).rejects.toThrow("session recreation exploded");

    const failed = await waitForChat(chat.config.id, (current) => current.state.status === "failed");
    expect(failed.state.error?.message).toBe("Error: session recreation exploded");
    expect(failed.state.session?.id).toBe(sessionId);
  });

  test("removes the chat worktree when deleting a worktree-backed chat", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Delete Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create the worktree",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const worktreePath = completed.state.worktree?.worktreePath;

    expect(worktreePath).toBeString();
    expect(await context.git.worktreeExists(context.workDir, worktreePath!)).toBe(true);
    expect((manager as unknown as ChatManagerInternals).activeStreamGenerations.has(chat.config.id)).toBe(true);

    expect(await manager.deleteChat(chat.config.id)).toBe(true);
    expect(await loadChat(chat.config.id)).toBeNull();
    expect(await context.git.worktreeExists(context.workDir, worktreePath!)).toBe(false);
    expect((manager as unknown as ChatManagerInternals).activeStreamGenerations.has(chat.config.id)).toBe(false);
  });

  test("accepts an immediate follow-up message after interrupting a running prompt", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    const events: ChatEvent[] = [];
    const emitter = new SimpleEventEmitter<ChatEvent>();
    emitter.subscribe((event) => {
      events.push(event);
    });

    backendManager.setBackendForTesting(new InterruptRaceBackend());

    const manager = new ChatManager(emitter);
    const chat = await manager.createChat({
      name: "Interrupt Recovery Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    const firstRun = await manager.sendMessage(chat.config.id, {
      message: "start a long response",
    });
    expect(firstRun.state.status).toBe("streaming");

    const interrupted = await manager.interruptChat(chat.config.id);
    expect(interrupted?.state.status).toBe("interrupting");

    await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    const resumed = await manager.sendMessage(chat.config.id, {
      message: "follow-up request",
    });
    expect(resumed.state.status).toBe("streaming");

    const settled = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Second response after interrupt"),
    );

    expect(settled.state.error).toBeUndefined();
    expect(
      settled.state.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([
      "start a long response",
      "follow-up request",
    ]);
    expect(settled.state.messages.some((message) => message.content === "Second response after interrupt")).toBe(true);
    expect(events.some((event) => event.type === "chat.error")).toBe(false);
  });

  test("drops the active stream immediately when interrupting a running prompt", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new InterruptRaceBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Interrupt Cleanup Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "start a long response",
    });

    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(true);

    const interrupted = await manager.interruptChat(chat.config.id);

    expect(interrupted?.state.status).toBe("interrupting");
    await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(false);
  });

  test("settles unsupported interrupts without persisting canceled output and keeps the same session for follow-up", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new UnsupportedInterruptBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Unsupported Interrupt Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "start a long response",
    });

    const interrupted = await manager.interruptChat(chat.config.id);
    const sessionId = interrupted?.state.session?.id;
    expect(interrupted?.state.status).toBe("interrupting");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(true);

    const settledAfterInterrupt = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(false);
    expect(settledAfterInterrupt.state.session?.id).toBe(sessionId);
    expect(
      settledAfterInterrupt.state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([]);

    const resumed = await manager.sendMessage(chat.config.id, {
      message: "follow-up request",
    });
    expect(resumed.state.session?.id).toBe(sessionId);

    const settled = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Second response after unsupported interrupt"),
    );

    expect(settled.state.session?.id).toBe(sessionId);
    expect(settled.state.messages.some((message) => message.content === "Second response after unsupported interrupt")).toBe(true);
    expect(settled.state.messages.some((message) => message.content === "First response that should be discarded after interrupt")).toBe(false);
  });
});
