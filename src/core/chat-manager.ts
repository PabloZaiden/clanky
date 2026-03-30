/**
 * Chat manager for long-lived ACP-backed chats.
 *
 * This is the initial runtime facade for chat CRUD and runtime metadata. It
 * owns chat records and event emission, and exposes dedicated backend hooks so
 * later API/runtime layers can bind ACP sessions without reaching directly into
 * persistence.
 */

import type { Backend, PromptInput, AgentEvent } from "../backends/types";
import type { Chat, ChatConfig, ChatStatus, LoopLogEntry, MessageData, PersistedToolCall, SessionInfo } from "../types";
import type { ChatEvent } from "../types/events";
import { createTimestamp } from "../types/events";
import type { MessageImageAttachment } from "../types/message-attachments";
import type { EventStream } from "../utils/event-stream";
import { createInitialChatState, DEFAULT_CHAT_CONFIG } from "../types/chat";
import { loadChat, listChats, listChatsByWorkspace, saveChat, deleteChat, updateChatConfig, updateChatState } from "../persistence/chats";
import { getWorkspace } from "../persistence/workspaces";
import { backendManager, buildConnectionConfig } from "./backend";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { nextWithTimeout } from "./engine/engine-helpers";
import { isSessionNotFoundError } from "./engine/engine-session";
import { createLogger } from "./logger";

const log = createLogger("chat-manager");
const DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

interface ActiveChatStream {
  stream: EventStream<AgentEvent>;
  promptPromise: Promise<void>;
}

export interface CreateChatOptions {
  name: string;
  workspaceId: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  useWorktree?: boolean;
  baseBranch?: string;
  directory?: string;
}

export class ChatManager {
  private readonly activeStreams = new Map<string, ActiveChatStream>();

  constructor(private readonly emitter: SimpleEventEmitter<ChatEvent> = chatEventEmitter) {}

  async createChat(options: CreateChatOptions): Promise<Chat> {
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }

    const name = options.name.trim();
    if (!name) {
      throw new Error("Chat name is required");
    }

    const id = crypto.randomUUID();
    const now = createTimestamp();
    const chat: Chat = {
      config: {
        id,
        name,
        workspaceId: options.workspaceId,
        directory: options.directory ?? workspace.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant,
        },
        useWorktree: options.useWorktree ?? DEFAULT_CHAT_CONFIG.useWorktree,
        baseBranch: options.baseBranch,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: createInitialChatState(id),
    };

    await saveChat(chat);
    this.emitter.emit({
      type: "chat.created",
      chatId: id,
      config: chat.config,
      timestamp: now,
    });
    return chat;
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return loadChat(chatId);
  }

  async getAllChats(): Promise<Chat[]> {
    return listChats();
  }

  async getChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
    return listChatsByWorkspace(workspaceId);
  }

  async updateChat(
    chatId: string,
    updates: Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode">>,
  ): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const config: ChatConfig = {
      ...chat.config,
      ...updates,
      model: updates.model ? { ...chat.config.model, ...updates.model } : chat.config.model,
      updatedAt: createTimestamp(),
    };

    const saved = await updateChatConfig(chatId, config);
    return saved ? { config, state: chat.state } : null;
  }

  async updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const state = {
      ...chat.state,
      status,
      lastActivityAt: createTimestamp(),
    };
    if (status === "stopped" || status === "failed") {
      state.completedAt = state.completedAt ?? state.lastActivityAt;
    }

    const saved = await updateChatState(chatId, state);
    if (!saved) {
      return null;
    }

    this.emitter.emit({
      type: "chat.status",
      chatId,
      status,
      timestamp: state.lastActivityAt,
    });
    return { config: chat.config, state };
  }

  async attachSession(chatId: string, session: SessionInfo): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const now = createTimestamp();
    const state = {
      ...chat.state,
      session,
      startedAt: chat.state.startedAt ?? now,
      lastActivityAt: now,
    };

    const saved = await updateChatState(chatId, state);
    return saved ? { config: chat.config, state } : null;
  }

  async reconnectSession(chatId: string): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const backend = await this.ensureBackendConnected(chat);
    if (!chat.state.session?.id) {
      return this.ensureSession(chat, backend);
    }

    try {
      const existing = await backend.getSession(chat.state.session.id);
      if (!existing) {
        return this.failLostSession(chat, `Session ${chat.state.session.id} not found during reconnect`);
      }
    } catch (error) {
      const message = String(error);
      if (isSessionNotFoundError(message)) {
        return this.failLostSession(chat, message);
      }
      throw error;
    }

    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: this.activeStreams.has(chatId) ? "streaming" : "idle",
      lastActivityAt: createTimestamp(),
    });
  }

  async sendMessage(
    chatId: string,
    options: {
      message?: string;
      attachments?: MessageImageAttachment[];
    },
  ): Promise<Chat> {
    const chat = await loadChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    if (chat.state.status === "streaming" || chat.state.status === "starting" || chat.state.status === "interrupting") {
      throw new Error("Chat is busy");
    }

    const backend = await this.ensureBackendConnected(chat);
    const sessionChat = await this.ensureSession(chat, backend);
    if (!sessionChat?.state.session?.id) {
      throw new Error("Failed to establish chat session");
    }

    const message = options.message?.trim() ?? "";
    const attachments = options.attachments ?? [];
    if (!message && attachments.length === 0) {
      throw new Error("Message or attachments are required");
    }

    const userMessage: MessageData = {
      id: `chat-user-${crypto.randomUUID()}`,
      role: "user",
      content: message,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: createTimestamp(),
    };

    let current = await this.appendMessage(sessionChat, userMessage);
    current = await this.updateChatStatusInternal(current, "starting");

    const prompt: PromptInput = {
      parts: [
        ...(message ? [{ type: "text" as const, text: message }] : []),
        ...attachments.map((attachment) => ({
          type: "image" as const,
          mimeType: attachment.mimeType,
          data: attachment.data,
          filename: attachment.filename,
        })),
      ],
      model: current.config.model,
    };

    const sessionId = current.state.session?.id;
    if (!sessionId) {
      throw new Error("Failed to establish chat session");
    }
    current = await this.startActivePrompt(current, backend, sessionId, prompt);
    return current;
  }

  async interruptChat(chatId: string, reason?: string): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    if (!chat.state.session?.id) {
      return chat;
    }

    const backend = await this.ensureBackendConnected(chat);
    const updating = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "interrupting",
      interruptRequested: true,
      lastActivityAt: createTimestamp(),
    });

    try {
      await backend.abortSession(chat.state.session.id);
    } catch (error) {
      const message = String(error);
      await this.emitChatError(updating, message);
      throw error;
    }

    const stopped = await this.updateChatStateAndReturn(updating, {
      ...updating.state,
      status: "idle",
      interruptRequested: false,
      completedAt: undefined,
      activeMessageId: undefined,
      lastActivityAt: createTimestamp(),
      error: reason
        ? {
            message: reason,
            timestamp: createTimestamp(),
            code: "interrupted",
          }
        : updating.state.error,
    });
    this.emitter.emit({
      type: "chat.interrupted",
      chatId,
      timestamp: stopped.state.lastActivityAt ?? createTimestamp(),
    });
    this.activeStreams.get(chatId)?.stream.close();
    this.activeStreams.delete(chatId);
    return stopped;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const deleted = await deleteChat(chatId);
    if (deleted) {
      this.emitter.emit({
        type: "chat.deleted",
        chatId,
        timestamp: createTimestamp(),
      });
      await backendManager.disconnectChat(chatId);
    }
    return deleted;
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return backendManager.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<void> {
    await backendManager.disconnectChat(chatId);
  }

  private async ensureBackendConnected(chat: Chat): Promise<Backend> {
    const workspace = await getWorkspace(chat.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    await backendManager.getBackendAsync(chat.config.workspaceId);
    const backend = this.getChatBackend(chat.config.id, chat.config.workspaceId);
    if (!backend.isConnected() || backend.getDirectory() !== chat.config.directory) {
      if (backend.isConnected()) {
        await backend.disconnect();
      }
      await backend.connect(buildConnectionConfig(workspace.serverSettings, chat.config.directory));
    }
    return backend;
  }

  private async ensureSession(chat: Chat, backend: Backend): Promise<Chat> {
    if (chat.state.session?.id) {
      try {
        const existing = await backend.getSession(chat.state.session.id);
        if (existing) {
          return chat;
        }
        return this.failLostSession(chat, `Session ${chat.state.session.id} not found`);
      } catch (error) {
        const message = String(error);
        if (isSessionNotFoundError(message)) {
          return this.failLostSession(chat, message);
        }
        throw error;
      }
    }

    const session = await backend.createSession({
      title: `Ralpher Chat: ${chat.config.name}`,
      directory: chat.config.directory,
      model: chat.config.model.modelID,
    });

    await this.configureSessionModel(backend, session.id, chat.config.model.modelID);

    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      session: {
        id: session.id,
      },
      startedAt: chat.state.startedAt ?? createTimestamp(),
      lastActivityAt: createTimestamp(),
    });
  }

  private async startActivePrompt(
    chat: Chat,
    backend: Backend,
    sessionId: string,
    prompt: PromptInput,
  ): Promise<Chat> {
    const eventStream = await backend.subscribeToEvents(sessionId);
    const promptPromise = backend.sendPromptAsync(sessionId, prompt);
    this.activeStreams.set(chat.config.id, {
      stream: eventStream,
      promptPromise,
    });
    void this.consumeEventStream(chat.config.id, eventStream, promptPromise);
    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "streaming",
      interruptRequested: false,
      completedAt: undefined,
      lastActivityAt: createTimestamp(),
    });
  }

  private async consumeEventStream(
    chatId: string,
    eventStream: EventStream<AgentEvent>,
    promptPromise: Promise<void>,
  ): Promise<void> {
    let chat = await loadChat(chatId);
    if (!chat) {
      eventStream.close();
      return;
    }

    let responseContent = "";
    let responseLogId: string | null = null;
    let responseLogContent = "";
    let reasoningLogId: string | null = null;
    let reasoningLogContent = "";
    let currentMessageId: string | null = null;
    const toolInputs = new Map<string, unknown>();

    try {
      await promptPromise;
      let event = await nextWithTimeout<AgentEvent>(eventStream, DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS);
      while (event !== null) {
        chat = await loadChat(chatId);
        if (!chat) {
          break;
        }

        const now = createTimestamp();
        chat = await this.updateChatStateAndReturn(chat, {
          ...chat.state,
          lastActivityAt: now,
        });

        switch (event.type) {
          case "message.start":
            currentMessageId = event.messageId;
            responseContent = "";
            responseLogId = null;
            responseLogContent = "";
            reasoningLogId = null;
            reasoningLogContent = "";
            chat = await this.emitChatLog(chat, "agent", "AI started generating response", { logKind: "system" });
            chat = await this.updateChatStateAndReturn(chat, {
              ...chat.state,
              activeMessageId: currentMessageId,
              lastActivityAt: now,
            });
            break;

          case "message.delta":
            responseContent += event.content;
            responseLogContent += event.content;
            chat = await this.emitChatLog(chat, "agent", "AI generating response...", {
              logKind: "response",
              responseContent: responseLogContent,
            }, responseLogId ?? undefined);
            responseLogId = chat.state.logs.at(-1)?.id ?? responseLogId;
            break;

          case "reasoning.delta":
            reasoningLogContent += event.content;
            chat = await this.emitChatLog(chat, "agent", "AI reasoning...", {
              logKind: "reasoning",
              responseContent: reasoningLogContent,
            }, reasoningLogId ?? undefined);
            reasoningLogId = chat.state.logs.at(-1)?.id ?? reasoningLogId;
            break;

          case "tool.start": {
            const toolId = `chat-tool-${crypto.randomUUID()}`;
            toolInputs.set(event.toolName, event.input);
            chat = await this.appendToolCall(chat, {
              id: toolId,
              name: event.toolName,
              input: event.input,
              status: "running",
              timestamp: now,
            });
            break;
          }

          case "tool.complete": {
            const toolName = event.toolName;
            const existing = [...chat.state.toolCalls].reverse().find((tool) => tool.name === toolName);
            chat = await this.upsertToolCall(chat, {
              id: existing?.id ?? `chat-tool-${crypto.randomUUID()}`,
              name: toolName,
              input: existing?.input ?? toolInputs.get(toolName),
              output: event.output,
              status: "completed",
              timestamp: now,
            });
            break;
          }

          case "session.status":
            if (event.status === "idle" && chat.state.status !== "interrupting") {
              chat = await this.updateChatStateAndReturn(chat, {
                ...chat.state,
                status: "idle",
                interruptRequested: false,
                lastActivityAt: now,
              });
            }
            break;

          case "message.complete": {
            chat = await this.emitChatLog(chat, "agent", "AI finished generating response", {
              logKind: "system",
              responseLength: responseContent.length,
            });
            const finalContent = responseContent || event.content;
            if (finalContent.length > 0 || currentMessageId) {
              chat = await this.appendMessage(chat, {
                id: currentMessageId ?? `chat-assistant-${crypto.randomUUID()}`,
                role: "assistant",
                content: finalContent,
                timestamp: now,
              });
            }
            chat = await this.updateChatStateAndReturn(chat, {
              ...chat.state,
              status: chat.state.interruptRequested ? "interrupting" : "idle",
              activeMessageId: undefined,
              interruptRequested: false,
              lastActivityAt: now,
            });
            this.activeStreams.delete(chatId);
            return;
          }

          case "error":
            await this.emitChatError(chat, event.message);
            this.activeStreams.delete(chatId);
            return;

          case "permission.asked":
            await this.emitChatError(chat, `Permission approval required: ${event.permission}`);
            return;

          case "question.asked":
            await this.emitChatError(
              chat,
              `Interactive question requires a UI response: ${event.questions.map((question) => question.question).join(" | ")}`,
            );
            return;
        }

        event = await nextWithTimeout<AgentEvent>(eventStream, DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS);
      }
    } catch (error) {
      chat = await loadChat(chatId);
      if (chat) {
        await this.emitChatError(chat, String(error));
      }
    } finally {
      eventStream.close();
      this.activeStreams.delete(chatId);
    }
  }

  private async appendMessage(chat: Chat, message: MessageData): Promise<Chat> {
    const nextMessages = chat.state.messages.some((existing) => existing.id === message.id)
      ? chat.state.messages.map((existing) => existing.id === message.id ? message : existing)
      : [...chat.state.messages, message];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      messages: nextMessages,
      lastActivityAt: message.timestamp,
    });
    this.emitter.emit({
      type: "chat.message",
      chatId: chat.config.id,
      message,
      timestamp: message.timestamp,
    });
    return updated;
  }

  private async emitChatLog(
    chat: Chat,
    level: LoopLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
    id?: string,
  ): Promise<Chat> {
    const entry: LoopLogEntry = {
      id: id ?? `chat-log-${crypto.randomUUID()}`,
      level,
      message,
      details,
      timestamp: createTimestamp(),
    };
    const existingIndex = chat.state.logs.findIndex((logEntry) => logEntry.id === entry.id);
    const logs = existingIndex >= 0
      ? chat.state.logs.map((logEntry, index) => index === existingIndex ? entry : logEntry)
      : [...chat.state.logs, entry];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      logs,
      lastActivityAt: entry.timestamp,
    });
    this.emitter.emit({
      type: "chat.log",
      chatId: chat.config.id,
      log: entry,
      timestamp: entry.timestamp,
    });
    return updated;
  }

  private async appendToolCall(chat: Chat, tool: PersistedToolCall): Promise<Chat> {
    const toolCalls = [...chat.state.toolCalls, tool];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      toolCalls,
      lastActivityAt: tool.timestamp,
    });
    this.emitter.emit({
      type: "chat.tool_call",
      chatId: chat.config.id,
      tool,
      timestamp: tool.timestamp,
    });
    return updated;
  }

  private async upsertToolCall(chat: Chat, tool: PersistedToolCall): Promise<Chat> {
    const existingIndex = chat.state.toolCalls.findIndex((existing) => existing.id === tool.id);
    const toolCalls = existingIndex >= 0
      ? chat.state.toolCalls.map((existing, index) => index === existingIndex ? tool : existing)
      : [...chat.state.toolCalls, tool];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      toolCalls,
      lastActivityAt: tool.timestamp,
    });
    this.emitter.emit({
      type: "chat.tool_call",
      chatId: chat.config.id,
      tool,
      timestamp: tool.timestamp,
    });
    return updated;
  }

  private async emitChatError(chat: Chat, message: string): Promise<Chat> {
    log.error("Chat runtime error", { chatId: chat.config.id, error: message });
    const now = createTimestamp();
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "failed",
      error: {
        message,
        timestamp: now,
      },
      completedAt: now,
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: now,
    });
    this.emitter.emit({
      type: "chat.error",
      chatId: chat.config.id,
      message,
      timestamp: now,
    });
    return updated;
  }

  private async failLostSession(chat: Chat, message: string): Promise<Chat> {
    return this.emitChatError(chat, message);
  }

  private async configureSessionModel(backend: Backend, sessionId: string, desiredModel: string): Promise<void> {
    try {
      await backend.setConfigOption(sessionId, "model", desiredModel);
      return;
    } catch {
      log.debug("Chat session config option not supported, trying setSessionModel", {
        sessionId,
        model: desiredModel,
      });
    }

    try {
      await backend.setSessionModel(sessionId, desiredModel);
    } catch (error) {
      log.warn("Failed to configure chat session model via ACP session controls", {
        sessionId,
        model: desiredModel,
        error: String(error),
      });
    }
  }

  private async updateChatStatusInternal(chat: Chat, status: ChatStatus): Promise<Chat> {
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status,
      lastActivityAt: createTimestamp(),
    });
    this.emitter.emit({
      type: "chat.status",
      chatId: chat.config.id,
      status,
      timestamp: updated.state.lastActivityAt ?? createTimestamp(),
    });
    return updated;
  }

  private async updateChatStateAndReturn(chat: Chat, state: Chat["state"]): Promise<Chat> {
    const saved = await updateChatState(chat.config.id, state);
    if (!saved) {
      throw new Error(`Failed to persist chat state for ${chat.config.id}`);
    }
    return {
      config: chat.config,
      state,
    };
  }
}

export const chatManager = new ChatManager();
