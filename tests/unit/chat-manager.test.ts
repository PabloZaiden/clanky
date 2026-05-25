import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { ChatManager } from "../../src/core/chat-manager";
import { backendManager } from "../../src/core/backend-manager";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import { GitService } from "../../src/core/git-service";
import { taskManager } from "../../src/core";
import { getPlanFilePath, getStatusFilePath } from "../../src/lib/planning-files";
import * as chatPersistence from "../../src/persistence/chats";
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

type ChatGitServiceMock = Pick<
  GitService,
  "worktreeExists" | "getCurrentBranch" | "checkoutBranch" | "pull" | "branchExists" | "createWorktree"
>;

function createChatGitServiceMock(methods: ChatGitServiceMock): GitService {
  return Object.assign(Object.create(GitService.prototype), methods) as GitService;
}

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

async function waitForValue<T>(
  getValue: () => T | undefined,
  timeoutMs = 5000,
  description = "value",
): Promise<T> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = getValue();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${description}`);
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

class ProgressiveStreamingBackend implements Backend {
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
      id: `progressive-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Hello world",
      parts: [{ type: "text", text: "Hello world" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: "assistant-progressive",
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "reasoning.delta",
        content: "Working through the transcript shape.",
      });
    }, 25);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Hello",
      });
    }, 50);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: " world",
      });
    }, 100);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Hello world",
      });
      subscription.end();
    }, 180);
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
          baseUrl: "http://progressive-streaming-backend",
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

class InterleavedResponseBackend implements Backend {
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
      id: `interleaved-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Alpha responseBeta after reasoning",
      parts: [{ type: "text", text: "Alpha responseBeta after reasoning" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: "assistant-interleaved",
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Alpha response",
      });
    }, 25);
    setTimeout(() => {
      subscription.push({
        type: "reasoning.delta",
        content: "Need more context.",
      });
    }, 50);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Beta after reasoning",
      });
    }, 75);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Alpha responseBeta after reasoning",
      });
      subscription.end();
    }, 120);
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
          baseUrl: "http://interleaved-response-backend",
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

class ToolInterleavedResponseBackend implements Backend {
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
      id: `tool-interleaved-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Alpha before toolBeta after tool",
      parts: [{ type: "text", text: "Alpha before toolBeta after tool" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: "assistant-tool-interleaved",
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Alpha before tool",
      });
    }, 25);
    setTimeout(() => {
      subscription.push({
        type: "tool.start",
        toolName: "read",
        input: { path: "/workspace/repo/README.md" },
      });
    }, 50);
    setTimeout(() => {
      subscription.push({
        type: "tool.complete",
        toolName: "read",
        output: { content: "README contents" },
      });
    }, 75);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Beta after tool",
      });
    }, 100);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Alpha before toolBeta after tool",
      });
      subscription.end();
    }, 140);
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
          baseUrl: "http://tool-interleaved-response-backend",
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

class ToolAtTurnEndBackend implements Backend {
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
      id: `tool-at-turn-end-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Alpha before tool",
      parts: [{ type: "text", text: "Alpha before tool" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: "assistant-tool-turn-end",
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Alpha before tool",
      });
    }, 25);
    setTimeout(() => {
      subscription.push({
        type: "tool.start",
        toolName: "read",
        input: { path: "/workspace/repo/README.md" },
      });
    }, 50);
    setTimeout(() => {
      subscription.push({
        type: "tool.complete",
        toolName: "read",
        output: { content: "README contents" },
      });
    }, 75);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Alpha before tool",
      });
      subscription.end();
    }, 100);
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
          baseUrl: "http://tool-at-turn-end-backend",
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

class ToolCompletedInputBackend implements Backend {
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
      id: `tool-completed-input-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Read complete",
      parts: [{ type: "text", text: "Read complete" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "tool.start",
        toolName: "read",
        input: {},
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "tool.complete",
        toolName: "read",
        input: { filePath: "/workspace/repo/README.md", offset: 1, limit: 40 },
        output: { content: "README contents" },
      });
    }, 10);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Read complete",
      });
      subscription.end();
    }, 20);
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
          baseUrl: "http://tool-completed-input-backend",
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

class RepeatedToolNameBackend implements Backend {
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
      id: `repeated-tool-name-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: `msg-${crypto.randomUUID()}`,
      content: "Done",
      parts: [{ type: "text", text: "Done" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: "assistant-repeated-tool-name",
      });
    }, 0);
    setTimeout(() => {
      subscription.push({
        type: "tool.start",
        toolCallId: "tool-view-a",
        toolName: "view",
        input: { path: "/workspace/repo/a.ts", view_range: [1, 20] },
      });
    }, 10);
    setTimeout(() => {
      subscription.push({
        type: "tool.start",
        toolCallId: "tool-view-b",
        toolName: "view",
        input: { path: "/workspace/repo/b.ts", view_range: [1, 20] },
      });
    }, 20);
    setTimeout(() => {
      subscription.push({
        type: "tool.complete",
        toolCallId: "tool-view-a",
        toolName: "view",
        input: { path: "/workspace/repo/a.ts", view_range: [1, 20] },
        output: { content: "contents from a.ts" },
      });
    }, 30);
    setTimeout(() => {
      subscription.push({
        type: "tool.complete",
        toolCallId: "tool-view-b",
        toolName: "view",
        input: { path: "/workspace/repo/b.ts", view_range: [1, 20] },
        output: { content: "contents from b.ts" },
      });
    }, 40);
    setTimeout(() => {
      subscription.push({
        type: "message.delta",
        content: "Done",
      });
    }, 50);
    setTimeout(() => {
      subscription.push({
        type: "message.complete",
        content: "Done",
      });
      subscription.end();
    }, 60);
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
          baseUrl: "http://repeated-tool-name-backend",
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

class IdleStatusInterruptBackend implements Backend {
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
      id: `idle-status-interrupt-${crypto.randomUUID()}`,
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
          content: "Second response after idle-status interrupt",
        });
        subscription.push({
          type: "message.complete",
          content: "Second response after idle-status interrupt",
        });
        subscription.end();
      }, 0);
      return;
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: `msg-${crypto.randomUUID()}`,
      });
    }, 0);
  }

  async abortSession(sessionId: string): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      return;
    }

    setTimeout(() => {
      subscription.push({
        type: "session.status",
        sessionId,
        status: "idle",
      });
      subscription.push({
        type: "message.complete",
        content: "",
      });
      subscription.end();
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
          baseUrl: "http://idle-status-interrupt-backend",
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

class StubbornToolInterruptBackend implements Backend {
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
      id: `stubborn-tool-interrupt-${crypto.randomUUID()}`,
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
          content: "Second response after stubborn tool interrupt",
        });
        subscription.push({
          type: "message.complete",
          content: "Second response after stubborn tool interrupt",
        });
        subscription.end();
      }, 0);
      return;
    }

    setTimeout(() => {
      subscription.push({
        type: "message.start",
        messageId: `msg-${crypto.randomUUID()}`,
      });
      subscription.push({
        type: "tool.start",
        toolCallId: `tool-${crypto.randomUUID()}`,
        toolName: "execute",
        input: { command: "sleep 45" },
      });
    }, 0);
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
          baseUrl: "http://stubborn-tool-interrupt-backend",
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

class PermissionGateBackend implements Backend {
  readonly name = "acp";

  private connected = false;
  private directory = "";
  private readonly sessions = new Map<string, AgentSession>();
  private readonly subscriptions = new Map<string, {
    stream: EventStream<AgentEvent>;
    push: (event: AgentEvent) => void;
    end: () => void;
  }>();
  readonly permissionReplies: Array<{ requestId: string; response: string }> = [];

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
    const session = {
      id: `permission-gate-${crypto.randomUUID()}`,
      title: options.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(_sessionId: string, _prompt: PromptInput): Promise<AgentResponse> {
    return {
      id: "unused",
      content: "unused",
      parts: [{ type: "text", text: "unused" }],
    };
  }

  async sendPromptAsync(sessionId: string, _prompt: PromptInput): Promise<void> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      throw new Error(`Missing subscription for ${sessionId}`);
    }

    setTimeout(() => {
      subscription.push({
        type: "permission.asked",
        requestId: "permission-1",
        sessionId,
        permission: "execute",
        patterns: ["bun test"],
      });
    }, 0);
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

  async replyToPermission(requestId: string, response: string): Promise<void> {
    this.permissionReplies.push({ requestId, response });
    const subscription = [...this.subscriptions.values()][0];
    if (!subscription) {
      throw new Error("Missing subscription for permission reply");
    }
    setTimeout(() => {
      subscription.push({ type: "message.start", messageId: `msg-${crypto.randomUUID()}` });
      subscription.push({ type: "message.delta", content: "Permission accepted" });
      subscription.push({ type: "message.complete", content: "Permission accepted" });
      subscription.end();
    }, 0);
  }

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

  failActivePrompt(message: string): void {
    const subscription = [...this.subscriptions.values()][0];
    if (!subscription) {
      throw new Error("Missing subscription for permission failure");
    }
    subscription.push({ type: "error", message });
    subscription.end();
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
          baseUrl: "http://permission-gate-backend",
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
  loadChatIfAvailable: (chatId: string) => Promise<Awaited<ReturnType<typeof loadChat>> | null>;
  ensureWorktree: (chat: NonNullable<Awaited<ReturnType<typeof loadChat>>>) => Promise<NonNullable<Awaited<ReturnType<typeof loadChat>>>>;
};

describe("ChatManager", () => {
  afterEach(async () => {
    if (context) {
      await teardownTestContext(context);
      context = undefined;
    }
  });

  test("generates project-based names for chats without explicit names", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const manager = new ChatManager();
    const firstChat = await manager.createChat({
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });
    const explicitChat = await manager.createChat({
      name: "Explicit Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });
    const thirdChat = await manager.createChat({
      name: "   ",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    expect(firstChat.config.name).toBe("Test Workspace - 1");
    expect(explicitChat.config.name).toBe("Explicit Chat");
    expect(thirdChat.config.name).toBe("Test Workspace - 3");
  });

  test("uses the next unused generated suffix after generated chats are deleted", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const manager = new ChatManager();
    const firstChat = await manager.createChat({
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });
    const secondChat = await manager.createChat({
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    expect(firstChat.config.name).toBe("Test Workspace - 1");
    expect(secondChat.config.name).toBe("Test Workspace - 2");

    await manager.deleteChat(firstChat.config.id);

    const nextChat = await manager.createChat({
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    expect(nextChat.config.name).toBe("Test Workspace - 3");
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
    expect(completed.state.worktree?.worktreePath).toBe(`${context.workDir}/.clanky-worktrees/${chat.config.id}`);
    expect(context.mockBackend?.getDirectory()).toBe(completed.state.worktree?.worktreePath);
    expect(
      await context.git.worktreeExists(
        context.workDir,
        `${context.workDir}/.clanky-worktrees/${chat.config.id}`,
      ),
    ).toBe(true);
    expect(completed.state.messages.map((message) => message.content)).toEqual([
      "Say hello",
      "Hello from the chat backend",
    ]);
  });

  test("creates worktree-backed standalone chats with an established worktree when no remote is configured", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Quick Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    const persisted = await loadChat(chat.config.id);
    const expectedWorktreePath = `${context.workDir}/.clanky-worktrees/${chat.config.id}`;

    expect(await context.git.hasRemote(context.workDir)).toBe(false);
    expect(chat.config.useWorktree).toBe(true);
    expect(chat.state.worktree?.originalBranch).toBeString();
    expect(chat.state.worktree?.workingBranch).toContain("chat-quick-chat-");
    expect(chat.state.worktree?.worktreePath).toBe(expectedWorktreePath);
    expect(persisted?.state.worktree?.worktreePath).toBe(expectedWorktreePath);
    expect(await context.git.worktreeExists(context.workDir, expectedWorktreePath)).toBe(true);
  });

  test("creates worktree-backed standalone chats in a repository with no commits or remote", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: false,
    });
    await Bun.$`git init`.cwd(context.workDir).quiet();
    await Bun.$`git config user.email "test@test.com"`.cwd(context.workDir).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(context.workDir).quiet();

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Unborn Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      ...testModelFields,
    });

    const expectedWorktreePath = `${context.workDir}/.clanky-worktrees/${chat.config.id}`;

    expect(await context.git.hasRemote(context.workDir)).toBe(false);
    expect(chat.state.worktree?.originalBranch).toBeString();
    expect(chat.state.worktree?.workingBranch).toContain("chat-unborn-chat-");
    expect(chat.state.worktree?.worktreePath).toBe(expectedWorktreePath);
    expect(await context.git.worktreeExists(context.workDir, expectedWorktreePath)).toBe(true);
  });

  test("auto-approves chat permission requests when enabled", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const backend = new PermissionGateBackend();
    backendManager.setBackendForTesting(backend);

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Auto Permission Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      autoApprovePermissions: true,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Run the check",
    });

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Permission accepted"),
    );

    expect(backend.permissionReplies).toEqual([{ requestId: "permission-1", response: "always" }]);
    expect(completed.state.pendingPermissionRequests ?? []).toEqual([]);
    expect(completed.state.error).toBeUndefined();
  });

  test("records chat permission requests and resumes after manual approval", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const backend = new PermissionGateBackend();
    backendManager.setBackendForTesting(backend);

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Manual Permission Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      autoApprovePermissions: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Run the check",
    });

    const waiting = await waitForChat(chat.config.id, (current) =>
      current.state.status === "streaming"
      && (current.state.pendingPermissionRequests ?? []).some((request) => request.status === "pending"),
    );
    expect(waiting.state.pendingPermissionRequests?.[0]).toMatchObject({
      requestId: "permission-1",
      permission: "execute",
      patterns: ["bun test"],
      status: "pending",
    });

    const approved = await manager.replyToPermission(chat.config.id, "permission-1", "allow");
    expect(approved?.state.pendingPermissionRequests?.[0]).toMatchObject({
      requestId: "permission-1",
      status: "approved",
      decision: "allow",
    });
    expect(backend.permissionReplies).toEqual([{ requestId: "permission-1", response: "once" }]);

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Permission accepted"),
    );
    expect(completed.state.error).toBeUndefined();
  });

  test("cancels pending chat permission requests on provider failure without recording a denial decision", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const backend = new PermissionGateBackend();
    backendManager.setBackendForTesting(backend);

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Failing Permission Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      autoApprovePermissions: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Run the check",
    });

    await waitForChat(chat.config.id, (current) =>
      current.state.status === "streaming"
      && (current.state.pendingPermissionRequests ?? []).some((request) => request.status === "pending"),
    );

    backend.failActivePrompt("Provider crashed while waiting for permission");

    const failed = await waitForChat(chat.config.id, (current) => current.state.status === "failed");
    expect(failed.state.pendingPermissionRequests?.[0]).toMatchObject({
      requestId: "permission-1",
      status: "cancelled",
      error: "Provider crashed while waiting for permission",
    });
    expect(failed.state.pendingPermissionRequests?.[0]?.decision).toBeUndefined();
  });

  test("cancels pending chat permission requests on interrupt without recording a denial decision", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      initGit: true,
    });

    const backend = new PermissionGateBackend();
    backendManager.setBackendForTesting(backend);

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Interrupted Permission Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      autoApprovePermissions: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Run the check",
    });

    const waiting = await waitForChat(chat.config.id, (current) =>
      current.state.status === "streaming"
      && (current.state.pendingPermissionRequests ?? []).some((request) => request.status === "pending"),
    );

    const interrupted = await (manager as unknown as {
      completeInterruptedChat: (chatToInterrupt: typeof waiting) => Promise<typeof waiting>;
    }).completeInterruptedChat(waiting);
    backend.abortAllSubscriptions();

    expect(interrupted.state.pendingPermissionRequests?.[0]).toMatchObject({
      requestId: "permission-1",
      status: "cancelled",
      error: "Interrupted",
    });
    expect(interrupted.state.pendingPermissionRequests?.[0]?.decision).toBeUndefined();
  });

  test("pulls the main checkout before creating a new chat worktree", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
    });

    const calls: string[] = [];
    let worktreeExists = false;
    const withExecutorSpy = spyOn(GitService, "withExecutor");
    withExecutorSpy.mockImplementation((_executor) => createChatGitServiceMock({
      worktreeExists: async () => worktreeExists,
      getCurrentBranch: async () => "feature/current",
      checkoutBranch: async (_directory: string, branch: string) => {
        calls.push(`checkout:${branch}`);
      },
      pull: async (_directory: string, branch?: string) => {
        calls.push(`pull:${branch}`);
        return true;
      },
      branchExists: async () => false,
      createWorktree: async (_directory: string, _worktreePath: string, branchName: string, originalBranch: string) => {
        calls.push(`createWorktree:${branchName}:${originalBranch}`);
        worktreeExists = true;
      },
    }));

    try {
      const manager = new ChatManager();
      const chat = await manager.createChat({
        name: "Runtime Chat",
        workspaceId: testWorkspaceId,
        directory: context.workDir,
        useWorktree: true,
        baseBranch: "main",
        ...testModelFields,
      });

      const started = await manager.sendMessage(chat.config.id, {
        message: "Say hello",
      });

      expect(started.state.status).toBe("streaming");
      expect(calls).toEqual([
        "checkout:main",
        "pull:main",
        `createWorktree:chat-runtime-chat-${chat.config.id.slice(0, 8)}:main`,
      ]);
      expect(context.mockBackend?.getDirectory()).toBe(`${context.workDir}/.clanky-worktrees/${chat.config.id}`);
    } finally {
      withExecutorSpy.mockRestore();
    }
  });

  test("can skip syncing the main checkout before creating a new chat worktree", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
    });

    const calls: string[] = [];
    let worktreeExists = false;
    const withExecutorSpy = spyOn(GitService, "withExecutor");
    withExecutorSpy.mockImplementation((_executor) => createChatGitServiceMock({
      worktreeExists: async () => worktreeExists,
      getCurrentBranch: async () => "feature/current",
      checkoutBranch: async (_directory: string, branch: string) => {
        calls.push(`checkout:${branch}`);
      },
      pull: async (_directory: string, branch?: string) => {
        calls.push(`pull:${branch}`);
        return true;
      },
      branchExists: async () => false,
      createWorktree: async (_directory: string, _worktreePath: string, branchName: string, originalBranch: string) => {
        calls.push(`createWorktree:${branchName}:${originalBranch}`);
        worktreeExists = true;
      },
    }));

    try {
      const manager = new ChatManager();
      const chat = await manager.createChat({
        name: "Quick Chat",
        workspaceId: testWorkspaceId,
        directory: context.workDir,
        useWorktree: true,
        baseBranch: "main",
        syncBaseBranch: false,
        ...testModelFields,
      });

      expect(calls).toEqual([
        `createWorktree:chat-quick-chat-${chat.config.id.slice(0, 8)}:main`,
      ]);
      expect(chat.config.skipBaseBranchSync).toBe(true);
      expect(chat.state.worktree?.worktreePath).toBe(`${context.workDir}/.clanky-worktrees/${chat.config.id}`);
    } finally {
      withExecutorSpy.mockRestore();
    }
  });

  test("waits for deferred worktree preparation when the chat sends its first message", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from deferred quick chat"],
    });

    const calls: string[] = [];
    let worktreeExists = false;
    const createWorktreeGate = Promise.withResolvers<void>();
    const withExecutorSpy = spyOn(GitService, "withExecutor");
    withExecutorSpy.mockImplementation((_executor) => createChatGitServiceMock({
      worktreeExists: async () => worktreeExists,
      getCurrentBranch: async () => "feature/current",
      checkoutBranch: async (_directory: string, branch: string) => {
        calls.push(`checkout:${branch}`);
      },
      pull: async (_directory: string, branch?: string) => {
        calls.push(`pull:${branch}`);
        return true;
      },
      branchExists: async () => false,
      createWorktree: async (_directory: string, _worktreePath: string, branchName: string, originalBranch: string) => {
        calls.push(`createWorktree:start:${branchName}:${originalBranch}`);
        await createWorktreeGate.promise;
        calls.push(`createWorktree:end:${branchName}:${originalBranch}`);
        worktreeExists = true;
      },
    }));

    try {
      const manager = new ChatManager();
      const chat = await manager.createChat({
        name: "Deferred Quick Chat",
        workspaceId: testWorkspaceId,
        directory: context.workDir,
        useWorktree: true,
        baseBranch: "main",
        syncBaseBranch: false,
        prepareWorktreeOnCreate: false,
        ...testModelFields,
      });

      expect(calls).toEqual([]);
      expect(chat.config.skipBaseBranchSync).toBe(true);
      expect(chat.state.worktree).toBeUndefined();

      await waitForValue(
        () => calls.find((call) => call.startsWith("createWorktree:start:")),
        5000,
        "background worktree preparation to start",
      );

      const startedPromise = manager.sendMessage(chat.config.id, {
        message: "Say hello",
      });
      createWorktreeGate.resolve();
      const started = await startedPromise;

      expect(started.state.status).toBe("streaming");
      expect(calls).toEqual([
        `createWorktree:start:chat-deferred-quick-chat-${chat.config.id.slice(0, 8)}:main`,
        `createWorktree:end:chat-deferred-quick-chat-${chat.config.id.slice(0, 8)}:main`,
      ]);
      expect(context.mockBackend?.getDirectory()).toBe(`${context.workDir}/.clanky-worktrees/${chat.config.id}`);
    } finally {
      withExecutorSpy.mockRestore();
    }
  });

  test("reuses persisted skip-base-branch-sync when recreating a missing chat worktree", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
    });

    const calls: string[] = [];
    let worktreeExists = false;
    const withExecutorSpy = spyOn(GitService, "withExecutor");
    withExecutorSpy.mockImplementation((_executor) => createChatGitServiceMock({
      worktreeExists: async () => worktreeExists,
      getCurrentBranch: async () => "feature/current",
      checkoutBranch: async (_directory: string, branch: string) => {
        calls.push(`checkout:${branch}`);
      },
      pull: async (_directory: string, branch?: string) => {
        calls.push(`pull:${branch}`);
        return true;
      },
      branchExists: async () => false,
      createWorktree: async (_directory: string, _worktreePath: string, branchName: string, originalBranch: string) => {
        calls.push(`createWorktree:${branchName}:${originalBranch}`);
        worktreeExists = true;
      },
    }));

    try {
      const manager = new ChatManager();
      const chat = await manager.createChat({
        name: "Quick Chat",
        workspaceId: testWorkspaceId,
        directory: context.workDir,
        useWorktree: true,
        baseBranch: "main",
        syncBaseBranch: false,
        ...testModelFields,
      });

      worktreeExists = false;
      const loaded = await loadChat(chat.config.id);
      expect(loaded?.config.skipBaseBranchSync).toBe(true);

      await (manager as unknown as ChatManagerInternals).ensureWorktree(loaded!);

      expect(calls).toEqual([
        `createWorktree:chat-quick-chat-${chat.config.id.slice(0, 8)}:main`,
        `createWorktree:chat-quick-chat-${chat.config.id.slice(0, 8)}:main`,
      ]);
    } finally {
      withExecutorSpy.mockRestore();
    }
  });

  test("checks out the selected branch for non-worktree chats without creating a managed chat branch", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
      initGit: true,
    });

    const originalBranch = await context.git.getCurrentBranch(context.workDir);
    const selectedBranch = "selected-chat-base";
    await context.git.createBranch(context.workDir, selectedBranch);
    await context.git.checkoutBranch(context.workDir, originalBranch);

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Runtime Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      baseBranch: selectedBranch,
      ...testModelFields,
    });

    const started = await manager.sendMessage(chat.config.id, {
      message: "Say hello",
    });

    expect(started.state.status).toBe("streaming");

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle" && current.state.messages.some((message) => message.role === "assistant"),
    );

    expect(completed.state.worktree).toBeUndefined();
    expect(context.mockBackend?.getDirectory()).toBe(context.workDir);
    expect(await context.git.getCurrentBranch(context.workDir)).toBe(selectedBranch);
    expect(
      (await context.git.getLocalBranches(context.workDir)).some((branch) =>
        branch.name.startsWith("chat-runtime-chat-"),
      ),
    ).toBe(false);
  });

  test("persists the active assistant message incrementally while streaming", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new ProgressiveStreamingBackend());
    const updateChatStateSpy = spyOn(chatPersistence, "updateChatState");

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Progressive Streaming Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Stream the reply",
    });

    const firstPartialAssistantPersist = await waitForValue(
      () => updateChatStateSpy.mock.calls
        .map(([, state]) => state)
        .find((state) =>
          state.status === "streaming"
          && state.messages.some((message) => message.role === "assistant" && message.content === "Hello"),
        ),
      5000,
      "the first partially persisted assistant message",
    );

    expect(
      firstPartialAssistantPersist.logs.some((log) =>
        log.details?.["logKind"] === "reasoning"
        && log.details?.["responseContent"] === "Working through the transcript shape."),
    ).toBe(true);
    const streamingAssistant = firstPartialAssistantPersist.messages.find((message) =>
      message.role === "assistant" && message.content === "Hello");
    expect(streamingAssistant?.timestamp).toBeDefined();
    expect(
      firstPartialAssistantPersist?.logs.some((log) =>
        log.details?.["logKind"] === "response"
        && log.details?.["responseContent"] === "Hello"),
    ).toBe(true);

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.role === "assistant" && message.content === "Hello world"),
    );

    expect(
      completed.state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(["Hello world"]);
    const completedAssistant = completed.state.messages.find((message) =>
      message.role === "assistant" && message.content === "Hello world");
    expect(completedAssistant?.timestamp).toBe(streamingAssistant?.timestamp);
  });

  test("creates a new assistant block when response streaming resumes after reasoning", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new InterleavedResponseBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Interleaved Response Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Explain the issue in parts",
    });

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.role === "assistant" && message.content === "Beta after reasoning"),
    );

    const assistantMessages = completed.state.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "Alpha response",
      "Beta after reasoning",
    ]);

    const responseLogs = completed.state.logs.filter((log) => log.details?.["logKind"] === "response");
    expect(responseLogs.map((log) => log.details?.["responseContent"])).toEqual([
      "Alpha response",
      "Beta after reasoning",
    ]);

    const reasoningLogs = completed.state.logs.filter((log) => log.details?.["logKind"] === "reasoning");
    expect(reasoningLogs.map((log) => log.details?.["responseContent"])).toEqual([
      "Need more context.",
    ]);

    const completionLog = completed.state.logs.find((log) => log.message === "AI finished generating response");
    expect(completionLog?.details?.["responseLength"]).toBe("Alpha responseBeta after reasoning".length);

    expect(assistantMessages[0]?.timestamp.localeCompare(reasoningLogs[0]?.timestamp ?? "")).toBeLessThan(0);
    expect(reasoningLogs[0]?.timestamp.localeCompare(assistantMessages[1]?.timestamp ?? "")).toBeLessThan(0);
  });

  test("creates a new assistant block when response streaming resumes after a tool call", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new ToolInterleavedResponseBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Tool Interleaved Response Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Explain the issue around the read call",
    });

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.role === "assistant" && message.content === "Beta after tool"),
    );

    const assistantMessages = completed.state.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "Alpha before tool",
      "Beta after tool",
    ]);

    const responseLogs = completed.state.logs.filter((log) => log.details?.["logKind"] === "response");
    expect(responseLogs.map((log) => log.details?.["responseContent"])).toEqual([
      "Alpha before tool",
      "Beta after tool",
    ]);

    expect(completed.state.toolCalls).toHaveLength(1);
    expect(completed.state.toolCalls[0]).toMatchObject({
      name: "read",
      status: "completed",
      input: { path: "/workspace/repo/README.md" },
      output: { content: "README contents" },
    });

    const toolTimestamp = completed.state.toolCalls[0]?.timestamp ?? "";
    expect(assistantMessages[0]?.timestamp.localeCompare(toolTimestamp)).toBeLessThan(0);
    expect(toolTimestamp.localeCompare(assistantMessages[1]?.timestamp ?? "")).toBeLessThan(0);
  });

  test("does not duplicate pre-tool assistant output when a tool ends the turn", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new ToolAtTurnEndBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Tool At Turn End Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Read the file and stop",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    const assistantMessages = completed.state.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.content)).toEqual([
      "Alpha before tool",
    ]);

    const responseLogs = completed.state.logs.filter((log) => log.details?.["logKind"] === "response");
    expect(responseLogs.map((log) => log.details?.["responseContent"])).toEqual([
      "Alpha before tool",
    ]);
  });

  test("replaces placeholder tool input with completed tool input", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new ToolCompletedInputBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Completed Input Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Read the file",
    });

    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    expect(completed.state.toolCalls).toHaveLength(1);
    expect(completed.state.toolCalls[0]).toMatchObject({
      name: "read",
      status: "completed",
      input: { filePath: "/workspace/repo/README.md", offset: 1, limit: 40 },
      output: { content: "README contents" },
    });
  });

  test("keeps repeated same-name tool calls attached to their own outputs", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new RepeatedToolNameBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Repeated Tool Name Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Inspect both files",
    });

    const completed = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle" && current.state.toolCalls.length === 2,
    );

    const summarizedToolCalls = completed.state.toolCalls
      .map((toolCall) => ({
        path: (toolCall.input as { path?: string }).path,
        status: toolCall.status,
        output: (toolCall.output as { content?: string } | undefined)?.content,
      }))
      .sort((left, right) => String(left.path).localeCompare(String(right.path)));

    expect(summarizedToolCalls).toEqual([
      {
        path: "/workspace/repo/a.ts",
        status: "completed",
        output: "contents from a.ts",
      },
      {
        path: "/workspace/repo/b.ts",
        status: "completed",
        output: "contents from b.ts",
      },
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

  test("emits chat.updated events when renaming a chat", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the chat backend"],
    });

    const events: ChatEvent[] = [];
    const emitter = new SimpleEventEmitter<ChatEvent>();
    emitter.subscribe((event) => {
      events.push(event);
    });

    const manager = new ChatManager(emitter);
    const chat = await manager.createChat({
      name: "Original Chat Name",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    const loadChatSpy = spyOn(chatPersistence, "loadChat");
    loadChatSpy.mockClear();

    const renamed = await manager.updateChat(chat.config.id, {
      name: "Renamed Chat",
    });

    expect(renamed).not.toBeNull();
    expect(renamed?.config.name).toBe("Renamed Chat");

    const updateEvent = events.find(
      (event): event is Extract<ChatEvent, { type: "chat.updated" }> => event.type === "chat.updated",
    );
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.chatId).toBe(chat.config.id);
    expect(updateEvent?.chat.config.name).toBe("Renamed Chat");
    expect(loadChatSpy).toHaveBeenCalledTimes(2);

    const persisted = await loadChat(chat.config.id);
    expect(persisted?.config.name).toBe("Renamed Chat");

    loadChatSpy.mockRestore();
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

  test("reconfigures an active session when the chat model changes", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Hello from the updated model"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Model Update Runtime Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Create the session",
    });
    const completed = await waitForChat(chat.config.id, (current) => current.state.status === "idle");
    const sessionId = completed.state.session?.id;

    expect(sessionId).toBeString();

    const updated = await manager.updateChat(chat.config.id, {
      model: {
        providerID: testModelFields.modelProviderID,
        modelID: "test-model-2",
        variant: "",
      },
    });

    expect(updated?.config.model.modelID).toBe("test-model-2");
    expect(context.mockBackend?.getConfigOptionUpdates().some((update) =>
      update.sessionId === sessionId && update.configId === "model" && update.value === "test-model-2"
    )).toBe(true);
  });

  test("uses the updated chat model for the next prompt after a model-only update", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Initial response", "Follow-up response"],
    });

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Prompt Model Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Initial prompt",
    });
    await waitForChat(chat.config.id, (current) => current.state.status === "idle");

    await manager.updateChat(chat.config.id, {
      model: {
        providerID: testModelFields.modelProviderID,
        modelID: "test-model-2",
        variant: "",
      },
    });

    await manager.sendMessage(chat.config.id, {
      message: "Use the new model",
    });
    await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Follow-up response"),
    );

    const lastPrompt = context.mockBackend?.getSentPrompts().at(-1);
    expect(lastPrompt?.model).toEqual({
      providerID: testModelFields.modelProviderID,
      modelID: "test-model-2",
      variant: "",
    });
  });

  test("spawns a task using the chat's updated model", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Chat response"],
      initGit: true,
    });

    const startPlanModeSpy = spyOn(taskManager, "startPlanMode");
    startPlanModeSpy.mockResolvedValue();

    try {
      const currentBranch = await context.git.getCurrentBranch(context.workDir);
      const manager = new ChatManager();
      const chat = await manager.createChat({
        name: "Spawn Model Chat",
        workspaceId: testWorkspaceId,
        directory: context.workDir,
        useWorktree: false,
        baseBranch: currentBranch,
        ...testModelFields,
      });

      await manager.sendMessage(chat.config.id, {
        message: "Turn this into a task",
      });
      await waitForChat(chat.config.id, (current) => current.state.status === "idle");

      await manager.updateChat(chat.config.id, {
        model: {
          providerID: testModelFields.modelProviderID,
          modelID: "test-model-2",
          variant: "",
        },
      });

      const spawned = await manager.spawnTaskFromChat(chat.config.id);

      expect(spawned.config.model).toEqual({
        providerID: testModelFields.modelProviderID,
        modelID: "test-model-2",
        variant: "",
      });
      expect(spawned.config.autoAcceptPlan).toBe(false);
      expect(spawned.config.fullyAutonomous).toBe(false);
      expect(spawned.state.status).toBe("planning");
    } finally {
      startPlanModeSpy.mockRestore();
    }
  });

  test("spawns a plan-ready task from the chat's current plan worktree", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Chat response"],
      initGit: true,
    });

    const manager = new ChatManager();
    const currentBranch = await context.git.getCurrentBranch(context.workDir);
    const chat = await manager.createChat({
      name: "Spawn Current Plan Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      baseBranch: currentBranch,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Turn this chat into a seeded plan task",
    });
    const settled = await waitForChat(
      chat.config.id,
      (current) => current.state.status === "idle" && Boolean(current.state.worktree?.worktreePath),
    );

    const chatWorktreePath = settled.state.worktree!.worktreePath!;
    await mkdir(join(chatWorktreePath, "plans"), { recursive: true });
    await writeFile(join(chatWorktreePath, "plans", "imported-plan.md"), "# Imported plan\n\n1. Do the seeded work.\n");
    await writeFile(join(chatWorktreePath, "plans", "status.md"), "# Imported status\n\nReady to review.");

    const spawned = await manager.spawnTaskFromCurrentPlan(chat.config.id, "plans/imported-plan.md");

    expect(spawned.config.autoAcceptPlan).toBe(false);
    expect(spawned.config.fullyAutonomous).toBe(false);
    expect(spawned.config.prompt).toBe("Implement the existing plan in .clanky-planning/plan.md.");
    expect(spawned.config.prompt).not.toContain("Turn this chat into a seeded plan task");
    expect(spawned.state.status).toBe("planning");
    expect(spawned.state.planMode?.isPlanReady).toBe(true);
    expect(spawned.state.planMode?.planContent).toContain("Imported plan");
    expect(spawned.state.session).toBeUndefined();

    const taskWorkDir = spawned.state.git?.worktreePath ?? spawned.config.directory;
    expect(await Bun.file(getPlanFilePath(taskWorkDir)).text()).toContain("Imported plan");
    expect(await Bun.file(getStatusFilePath(taskWorkDir)).text()).toBe("# Imported status\n\nReady to review.");
  });

  test("allows selected absolute plan paths outside the chat workspace", async () => {
    context = await setupTestContext({
      useMockBackend: true,
      mockResponses: ["Chat response"],
      initGit: true,
    });

    const manager = new ChatManager();
    const currentBranch = await context.git.getCurrentBranch(context.workDir);
    const chat = await manager.createChat({
      name: "Spawn Invalid Path Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: true,
      baseBranch: currentBranch,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "Turn this chat into a seeded plan task",
    });
    await waitForChat(
      chat.config.id,
      (current) => current.state.status === "idle" && Boolean(current.state.worktree?.worktreePath),
    );

    const importedPlanDir = join(context.dataDir, "external-plan-files");
    await mkdir(importedPlanDir, { recursive: true });
    const importedPlanPath = join(importedPlanDir, "external-plan.md");
    await writeFile(importedPlanPath, "# Imported plan\n\n1. Use an absolute path.\n");
    await writeFile(join(importedPlanDir, "status.md"), "# Imported status\n\nReady from outside workspace.");

    const spawned = await manager.spawnTaskFromCurrentPlan(chat.config.id, importedPlanPath);

    expect(spawned.state.planMode?.planContent).toBe("# Imported plan\n\n1. Use an absolute path.");
    const taskWorkDir = spawned.state.git?.worktreePath ?? spawned.config.directory;
    expect(await Bun.file(getPlanFilePath(taskWorkDir)).text()).toContain("# Imported plan\n\n1. Use an absolute path.");
    expect(await Bun.file(getStatusFilePath(taskWorkDir)).text()).toBe("# Imported status\n\nReady from outside workspace.");
  });

  test("treats uninitialized database errors by error message instead of String(error)", async () => {
    class DatabaseNotInitializedError extends Error {
      override toString(): string {
        return `WrappedError(${this.message})`;
      }
    }

    const loadChatSpy = spyOn(chatPersistence, "loadChat");
    loadChatSpy.mockImplementation(async () => {
      throw new DatabaseNotInitializedError("Database not initialized. Call initializeDatabase() first.");
    });

    const manager = new ChatManager();
    const chat = await (manager as unknown as ChatManagerInternals).loadChatIfAvailable("chat-id");

    expect(chat).toBeNull();

    loadChatSpy.mockRestore();
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
    expect(interrupted?.state.status).toBe("idle");

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

    expect(interrupted?.state.status).toBe("idle");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(false);
  });

  test("stops an interrupted generation after idle status and ignores trailing completion events", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new IdleStatusInterruptBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Idle Status Interrupt Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "start a long response",
    });

    const interrupted = await manager.interruptChat(chat.config.id);
    expect(interrupted?.state.status).toBe("idle");

    const settledAfterInterrupt = interrupted!;
    expect(
      settledAfterInterrupt.state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([]);

    const resumed = await manager.sendMessage(chat.config.id, {
      message: "follow-up request",
    });
    expect(resumed.state.status).toBe("streaming");

    const settled = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Second response after idle-status interrupt"),
    );

    expect(settled.state.messages.some((message) => message.content === "Second response after idle-status interrupt")).toBe(true);
    expect(settled.state.messages.some((message) => message.role === "assistant" && message.content === "")).toBe(false);
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
    expect(interrupted?.state.status).toBe("idle");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(false);

    const settledAfterInterrupt = interrupted!;
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

  test("accepts an immediate follow-up after interrupting a stubborn running tool", async () => {
    context = await setupTestContext({
      useMockBackend: true,
    });

    backendManager.setBackendForTesting(new StubbornToolInterruptBackend());

    const manager = new ChatManager();
    const chat = await manager.createChat({
      name: "Stubborn Tool Interrupt Chat",
      workspaceId: testWorkspaceId,
      directory: context.workDir,
      useWorktree: false,
      ...testModelFields,
    });

    await manager.sendMessage(chat.config.id, {
      message: "start a long tool",
    });

    await waitForChat(chat.config.id, (current) =>
      current.state.status === "streaming"
      && current.state.toolCalls.some((toolCall) => toolCall.status === "running"),
    );

    const interrupted = await manager.interruptChat(chat.config.id);
    expect(interrupted?.state.status).toBe("idle");
    expect((manager as unknown as ChatManagerInternals).activeStreams.has(chat.config.id)).toBe(false);
    expect(interrupted?.state.toolCalls).toEqual([
      expect.objectContaining({
        name: "execute",
        status: "failed",
        output: "Interrupted",
      }),
    ]);

    const resumed = await manager.sendMessage(chat.config.id, {
      message: "follow-up request",
    });
    expect(resumed.state.status).toBe("streaming");

    const settled = await waitForChat(chat.config.id, (current) =>
      current.state.status === "idle"
      && current.state.messages.some((message) => message.content === "Second response after stubborn tool interrupt"),
    );

    expect(settled.state.messages.some((message) => message.content === "Second response after stubborn tool interrupt")).toBe(true);
    expect(settled.state.error).toBeUndefined();
  });
});
