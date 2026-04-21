/**
 * Chat manager for long-lived ACP-backed chats.
 *
 * This is the initial runtime facade for chat CRUD and runtime metadata. It
 * owns chat records and event emission, and exposes dedicated backend hooks so
 * later API/runtime layers can bind ACP sessions without reaching directly into
 * persistence.
 */

import type { Backend, PromptInput, AgentEvent } from "../backends/types";
import type { Chat, ChatConfig, ChatStatus, Loop, LoopLogEntry, MessageData, PersistedToolCall, SessionInfo } from "../types";
import type { ChatEvent } from "../types/events";
import { createTimestamp } from "../types/events";
import type { MessageImageAttachment } from "../types/message-attachments";
import type { EventStream } from "../utils/event-stream";
import { ChatBusyError, createInitialChatState, DEFAULT_CHAT_CONFIG, isChatBusyStatus } from "../types/chat";
import { loadChat, listChats, listChatsByWorkspace, saveChat, deleteChat, updateChatConfig, updateChatState } from "../persistence/chats";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import { backendManager, buildConnectionConfig } from "./backend";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { nextWithTimeout } from "./engine/engine-helpers";
import { isSessionNotFoundError } from "./engine/engine-session";
import { GitService } from "./git";
import { syncMainCheckoutBeforeWorktree } from "./git/worktree-sync";
import { loopManager } from "./loop-manager";
import { createLogger } from "./logger";
import { buildSeededPlanStatusContent, readValidatedPlanningFiles } from "./planning-file-service";
import { sanitizeBranchName } from "../utils";
import { buildSpawnLoopName, buildSpawnLoopPrompt } from "../utils/chat-to-loop-prompt";

const log = createLogger("chat-manager");
const DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const DATABASE_NOT_INITIALIZED_MESSAGE = "Database not initialized. Call initializeDatabase() first.";

interface ActiveChatStream {
  stream: EventStream<AgentEvent>;
  promptPromise: Promise<void>;
  generation: number;
}

function isDatabaseNotInitializedError(error: unknown): boolean {
  return error instanceof Error && error.message === DATABASE_NOT_INITIALIZED_MESSAGE;
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
  private readonly activeStreamGenerations = new Map<string, number>();

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
          variant: options.modelVariant ?? "",
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
    if (!saved) {
      return null;
    }

    let updatedChat = await loadChat(chatId);
    if (!updatedChat) {
      return null;
    }

    if (updates.model && updatedChat.state.session?.id) {
      try {
        const backend = await this.ensureBackendConnected(updatedChat);
        await this.configureSessionModel(backend, updatedChat.state.session.id, updatedChat.config.model.modelID);
        updatedChat = await loadChat(chatId) ?? updatedChat;
      } catch (error) {
        log.warn("Failed to reconfigure active chat session after model update", {
          chatId,
          model: updatedChat.config.model.modelID,
          error: String(error),
        });
      }
    }

    this.emitter.emit({
      type: "chat.updated",
      chatId,
      chat: updatedChat,
      timestamp: updatedChat.config.updatedAt,
    });
    return updatedChat;
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

    return this.updateChatStateAndReturn(chat, state);
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
    let reconnectingChat = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "reconnecting",
      error: undefined,
      lastActivityAt: createTimestamp(),
    });

    try {
      if (!reconnectingChat.state.session?.id) {
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
        return this.finishReconnect(reconnectingChat, chatId);
      }

      try {
        const existing = await backend.getSession(reconnectingChat.state.session.id);
        if (!existing) {
          reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
          return this.finishReconnect(reconnectingChat, chatId);
        }
      } catch (error) {
        const message = String(error);
        if (!isSessionNotFoundError(message)) {
          throw error;
        }
        reconnectingChat = await this.ensureSession(reconnectingChat, backend, { recreateIfMissing: true });
        return this.finishReconnect(reconnectingChat, chatId);
      }
    } catch (error) {
      await this.emitChatError(reconnectingChat, String(error));
      throw error;
    }

    return this.finishReconnect(reconnectingChat, chatId);
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

    this.assertChatIsAvailable(chat);

    const backend = await this.ensureBackendConnected(chat);
    const sessionChat = await this.ensureSession(chat, backend, { recreateIfMissing: true });
    if (!sessionChat?.state.session?.id) {
      throw new Error("Failed to establish chat session");
    }

    await this.configureSessionModel(backend, sessionChat.state.session.id, sessionChat.config.model.modelID);

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
    current = await this.updateChatStateAndReturn(current, {
      ...current.state,
      status: "starting",
      error: undefined,
      completedAt: undefined,
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: createTimestamp(),
    });

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
    const interrupted = await this.updateChatStateAndReturn(updating, {
      ...updating.state,
      error: reason
        ? {
            message: reason,
            timestamp: createTimestamp(),
            code: "interrupted",
          }
        : updating.state.error,
    });
    if (!this.activeStreams.has(chatId)) {
      return this.completeInterruptedChat(interrupted);
    }
    return interrupted;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return false;
    }

    this.activeStreams.get(chatId)?.stream.close();
    this.activeStreams.delete(chatId);
    this.activeStreamGenerations.delete(chatId);
    await backendManager.disconnectChat(chatId);
    await this.cleanupWorktree(chat);

    const deleted = await deleteChat(chatId);
    if (deleted) {
      this.emitter.emit({
        type: "chat.deleted",
        chatId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }

  async spawnLoopFromChat(chatId: string): Promise<Loop> {
    const chat = await loadChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    this.assertChatIsAvailable(chat);

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const baseBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getDefaultBranch(chat.config.directory);

    const prompt = buildSpawnLoopPrompt(chat.config.name, chat.state.messages);

    await touchWorkspace(chat.config.workspaceId);

    const loop = await loopManager.createLoop({
      name: buildSpawnLoopName(chat.config.name),
      directory: chat.config.directory,
      prompt,
      workspaceId: chat.config.workspaceId,
      modelProviderID: chat.config.model.providerID,
      modelID: chat.config.model.modelID,
      modelVariant: chat.config.model.variant,
      baseBranch,
      useWorktree: chat.config.useWorktree,
      planMode: true,
    });

    try {
      await loopManager.startPlanMode(loop.config.id);
      await loopManager.saveLastUsedModel(chat.config.model);
    } catch (error) {
      try {
        await loopManager.deleteLoop(loop.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned loop after plan-mode start failure", {
          loopId: loop.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to start spawned loop in plan mode", { cause: error });
    }

    return await loopManager.getLoop(loop.config.id) ?? loop;
  }

  async spawnLoopFromCurrentPlan(chatId: string): Promise<Loop> {
    const chat = await loadChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    this.assertChatIsAvailable(chat);

    const working = await this.resolveWorkingDirectory(chat);
    const workingExecutor = await backendManager.getCommandExecutorAsync(
      working.chat.config.workspaceId,
      working.directory,
    );
    const currentPlan = await readValidatedPlanningFiles(workingExecutor, working.directory);

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const baseBranch = working.chat.state.worktree?.originalBranch
      ?? working.chat.config.baseBranch
      ?? await git.getDefaultBranch(working.chat.config.directory);

    const prompt = buildSpawnLoopPrompt(working.chat.config.name, working.chat.state.messages);

    await touchWorkspace(working.chat.config.workspaceId);

    const loop = await loopManager.createLoop({
      name: buildSpawnLoopName(working.chat.config.name),
      directory: working.chat.config.directory,
      prompt,
      workspaceId: working.chat.config.workspaceId,
      modelProviderID: working.chat.config.model.providerID,
      modelID: working.chat.config.model.modelID,
      modelVariant: working.chat.config.model.variant,
      baseBranch,
      useWorktree: working.chat.config.useWorktree,
      planMode: true,
    });

    try {
      await loopManager.seedPlanFiles(loop.config.id, {
        planContent: currentPlan.planContent,
        statusContent: currentPlan.statusContent ?? buildSeededPlanStatusContent(loop.config.name),
      });
      await loopManager.saveLastUsedModel(working.chat.config.model);
    } catch (error) {
      try {
        await loopManager.deleteLoop(loop.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned loop after current-plan seed failure", {
          loopId: loop.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to seed spawned loop from the current plan", { cause: error });
    }

    return await loopManager.getLoop(loop.config.id) ?? loop;
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return backendManager.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<void> {
    await backendManager.disconnectChat(chatId);
  }

  private assertChatIsAvailable(chat: Chat): void {
    if (isChatBusyStatus(chat.state.status)) {
      throw new ChatBusyError();
    }
  }

  private async ensureBackendConnected(chat: Chat): Promise<Backend> {
    const workspace = await getWorkspace(chat.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const working = await this.resolveWorkingDirectory(chat);
    await backendManager.getBackendAsync(chat.config.workspaceId);
    const backend = this.getChatBackend(working.chat.config.id, working.chat.config.workspaceId);
    if (!backend.isConnected() || backend.getDirectory() !== working.directory) {
      if (backend.isConnected()) {
        await backend.disconnect();
      }
      await backend.connect(buildConnectionConfig(workspace.serverSettings, working.directory));
    }
    return backend;
  }

  private async ensureSession(
    chat: Chat,
    backend: Backend,
    options?: {
      recreateIfMissing?: boolean;
    },
  ): Promise<Chat> {
    if (chat.state.session?.id) {
      try {
        const existing = await backend.getSession(chat.state.session.id);
        if (existing) {
          return chat;
        }
        if (options?.recreateIfMissing) {
          return this.recreateSession(chat, backend);
        }
        return this.failLostSession(chat, `Session ${chat.state.session.id} not found`);
      } catch (error) {
        const message = String(error);
        if (isSessionNotFoundError(message)) {
          if (options?.recreateIfMissing) {
            return this.recreateSession(chat, backend);
          }
          return this.failLostSession(chat, message);
        }
        throw error;
      }
    }

    return this.createSession(chat, backend);
  }

  private async createSession(chat: Chat, backend: Backend): Promise<Chat> {
    const working = await this.resolveWorkingDirectory(chat);
    const session = await backend.createSession({
      title: `Ralpher Chat: ${working.chat.config.name}`,
      directory: working.directory,
      model: working.chat.config.model.modelID,
    });

    await this.configureSessionModel(backend, session.id, working.chat.config.model.modelID);

    return this.updateChatStateAndReturn(working.chat, {
      ...working.chat.state,
      session: {
        id: session.id,
      },
      startedAt: working.chat.state.startedAt ?? createTimestamp(),
      lastActivityAt: createTimestamp(),
      error: undefined,
    });
  }

  private async recreateSession(chat: Chat, backend: Backend): Promise<Chat> {
    const reconnecting = chat.state.status === "reconnecting"
      ? chat
      : await this.updateChatStateAndReturn(chat, {
          ...chat.state,
          status: "reconnecting",
          error: undefined,
          completedAt: undefined,
          activeMessageId: undefined,
          interruptRequested: false,
          lastActivityAt: createTimestamp(),
        });
    try {
      return await this.createSession(reconnecting, backend);
    } catch (error) {
      await this.emitChatError(reconnecting, String(error));
      throw error;
    }
  }

  private async resolveWorkingDirectory(chat: Chat): Promise<{ chat: Chat; directory: string }> {
    if (!chat.config.useWorktree) {
      return {
        chat,
        directory: chat.config.directory,
      };
    }

    const prepared = await this.ensureWorktree(chat);
    const worktreePath = prepared.state.worktree?.worktreePath;
    if (!worktreePath) {
      throw new Error(`Chat ${chat.config.id} is configured to use a worktree but no worktree path was recorded`);
    }

    return {
      chat: prepared,
      directory: worktreePath,
    };
  }

  private async ensureWorktree(chat: Chat): Promise<Chat> {
    if (!chat.config.useWorktree) {
      return chat;
    }

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const originalBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getCurrentBranch(chat.config.directory);
    const workingBranch = chat.state.worktree?.workingBranch
      ?? this.buildWorkingBranchName(chat);
    const worktreePath = chat.state.worktree?.worktreePath
      ?? `${chat.config.directory}/.ralph-worktrees/${chat.config.id}`;

    const worktreeExists = await git.worktreeExists(chat.config.directory, worktreePath);
    if (!worktreeExists) {
      await syncMainCheckoutBeforeWorktree({
        git,
        directory: chat.config.directory,
        baseBranch: originalBranch,
        onInfo: (message: string) => {
          log.info(`[ChatManager] ${message}`);
        },
        onDebug: (message: string) => {
          log.debug(`[ChatManager] ${message}`);
        },
      });

      const branchExists = await git.branchExists(chat.config.directory, workingBranch);
      if (branchExists) {
        await git.addWorktreeForExistingBranch(chat.config.directory, worktreePath, workingBranch);
      } else {
        await git.createWorktree(chat.config.directory, worktreePath, workingBranch, originalBranch);
      }
    }

    const nextWorktreeState = {
      originalBranch,
      workingBranch,
      worktreePath,
    };
    if (
      chat.state.worktree?.originalBranch === nextWorktreeState.originalBranch
      && chat.state.worktree?.workingBranch === nextWorktreeState.workingBranch
      && chat.state.worktree?.worktreePath === nextWorktreeState.worktreePath
    ) {
      return chat;
    }

    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      worktree: nextWorktreeState,
      lastActivityAt: chat.state.lastActivityAt ?? createTimestamp(),
    });
  }

  private async cleanupWorktree(chat: Chat): Promise<void> {
    const worktreePath = chat.state.worktree?.worktreePath;
    if (!chat.config.useWorktree || !worktreePath) {
      return;
    }

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    await git.ensureWorktreeRemoved(chat.config.directory, worktreePath, {
      force: true,
    });
  }

  private buildWorkingBranchName(chat: Chat): string {
    return `chat-${sanitizeBranchName(chat.config.name)}-${chat.config.id.slice(0, 8)}`;
  }

  private async finishReconnect(chat: Chat, chatId: string): Promise<Chat> {
    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: this.activeStreams.has(chatId) ? "streaming" : "idle",
      error: undefined,
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
    const generation = this.nextActiveStreamGeneration(chat.config.id);
    this.activeStreams.set(chat.config.id, {
      stream: eventStream,
      promptPromise,
      generation,
    });
    void this.consumeEventStream(chat.config.id, eventStream, promptPromise, generation);
    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "streaming",
      error: undefined,
      interruptRequested: false,
      completedAt: undefined,
      lastActivityAt: createTimestamp(),
    });
  }

  private async consumeEventStream(
    chatId: string,
    eventStream: EventStream<AgentEvent>,
    promptPromise: Promise<void>,
    generation: number,
  ): Promise<void> {
    let chat = await loadChat(chatId);
    if (!chat) {
      eventStream.close();
      return;
    }

    let currentTurnMessageId: string | null = null;
    let currentResponseMessageId: string | null = null;
    let currentResponseContent = "";
    let currentResponseLogId: string | null = null;
    let currentResponseLogContent = "";
    let currentResponseTimestamp: string | null = null;
    let totalResponseLength = 0;
    let responseSegmentCount = 0;
    let currentReasoningLogId: string | null = null;
    let currentReasoningLogContent = "";
    let currentStreamBlockKind: "response" | "reasoning" | null = null;
    const toolInputs = new Map<string, unknown>();
    const resetActiveStreamBlock = (): void => {
      currentResponseMessageId = null;
      currentResponseContent = "";
      currentResponseLogId = null;
      currentResponseLogContent = "";
      currentResponseTimestamp = null;
      currentReasoningLogId = null;
      currentReasoningLogContent = "";
      currentStreamBlockKind = null;
    };
    const resetCurrentTurnStreamState = (): void => {
      currentTurnMessageId = null;
      totalResponseLength = 0;
      responseSegmentCount = 0;
      resetActiveStreamBlock();
    };

    try {
      await promptPromise;
      let event = await nextWithTimeout<AgentEvent>(eventStream, DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS);
      while (event !== null) {
        if (!this.isActiveStreamGeneration(chatId, generation)) {
          return;
        }
        chat = await loadChat(chatId);
        if (!chat) {
          break;
        }

        const now = createTimestamp();
        const isInterrupted = chat.state.status === "interrupting" || chat.state.interruptRequested;

        switch (event.type) {
          case "message.start":
            resetCurrentTurnStreamState();
            currentTurnMessageId = event.messageId;
            if (isInterrupted) {
              break;
            }
            chat = await this.emitChatLog(chat, "agent", "AI started generating response", { logKind: "system" });
            chat = await this.updateChatStateAndReturn(chat, {
              ...chat.state,
              activeMessageId: undefined,
              lastActivityAt: now,
            });
            break;

          case "message.delta":
            if (isInterrupted) {
              break;
            }
            if (currentStreamBlockKind !== "response") {
              responseSegmentCount += 1;
              currentResponseMessageId = this.createResponseSegmentMessageId(currentTurnMessageId, responseSegmentCount);
              currentResponseContent = "";
              currentResponseLogId = `chat-log-${crypto.randomUUID()}`;
              currentResponseLogContent = "";
              currentResponseTimestamp = now;
              currentStreamBlockKind = "response";
            }
            currentResponseContent += event.content;
            currentResponseLogContent += event.content;
            totalResponseLength += event.content.length;
            ({
              chat,
              messageId: currentResponseMessageId,
              responseLogId: currentResponseLogId,
            } = await this.updateStreamingAssistantProgress(chat, {
              messageId: currentResponseMessageId,
              content: currentResponseContent,
              responseLogId: currentResponseLogId,
              responseLogContent: currentResponseLogContent,
              timestamp: currentResponseTimestamp ?? now,
              activityTimestamp: now,
            }));
            break;

          case "reasoning.delta":
            if (isInterrupted) {
              break;
            }
            if (currentStreamBlockKind !== "reasoning") {
              currentReasoningLogId = `chat-log-${crypto.randomUUID()}`;
              currentReasoningLogContent = "";
              currentStreamBlockKind = "reasoning";
            }
            currentReasoningLogContent += event.content;
            chat = await this.emitChatLog(chat, "agent", "AI reasoning...", {
              logKind: "reasoning",
              responseContent: currentReasoningLogContent,
            }, currentReasoningLogId ?? undefined, now);
            break;

          case "tool.start": {
            if (isInterrupted) {
              break;
            }
            resetActiveStreamBlock();
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
            if (isInterrupted) {
              break;
            }
            resetActiveStreamBlock();
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
            if (event.status === "idle" && (chat.state.status === "interrupting" || chat.state.interruptRequested)) {
              chat = await this.completeInterruptedChat(chat);
              this.clearActiveStream(chatId, generation);
              return;
            } else if (event.status === "idle") {
              chat = await this.updateChatStateAndReturn(chat, {
                ...chat.state,
                status: "idle",
                interruptRequested: false,
                lastActivityAt: now,
              });
            }
            break;

          case "message.complete": {
            if (isInterrupted) {
              chat = await this.completeInterruptedChat(chat);
              this.clearActiveStream(chatId, generation);
              return;
            }
            const completedResponseLength = event.content.length > 0
              ? event.content.length
              : totalResponseLength;
            chat = await this.emitChatLog(chat, "agent", "AI finished generating response", {
              logKind: "system",
              responseLength: completedResponseLength,
            });
            if (responseSegmentCount === 0 && event.content.length > 0) {
              responseSegmentCount += 1;
              currentResponseMessageId = this.createResponseSegmentMessageId(currentTurnMessageId, responseSegmentCount);
              currentResponseContent = event.content;
              currentResponseLogId = `chat-log-${crypto.randomUUID()}`;
              currentResponseLogContent = event.content;
              currentResponseTimestamp = now;
              totalResponseLength = event.content.length;
              currentStreamBlockKind = "response";
              ({
                chat,
                messageId: currentResponseMessageId,
                responseLogId: currentResponseLogId,
              } = await this.updateStreamingAssistantProgress(chat, {
                messageId: currentResponseMessageId,
                content: currentResponseContent,
                responseLogId: currentResponseLogId,
                responseLogContent: currentResponseLogContent,
                timestamp: currentResponseTimestamp,
                activityTimestamp: now,
              }));
            }
            if (chat.state.interruptRequested || chat.state.status === "interrupting") {
              chat = await this.completeInterruptedChat(chat);
            } else {
              chat = await this.updateChatStateAndReturn(chat, {
                ...chat.state,
                status: "idle",
                activeMessageId: undefined,
                interruptRequested: false,
                lastActivityAt: now,
              });
            }
            this.clearActiveStream(chatId, generation);
            return;
          }

          case "error":
            if (this.shouldSuppressStreamError(chatId, generation, event.message)) {
              chat = await loadChat(chatId) ?? chat;
              if (chat.state.status === "interrupting" || chat.state.interruptRequested) {
                await this.completeInterruptedChat(chat);
              }
              this.clearActiveStream(chatId, generation);
              return;
            }
            await this.emitChatError(chat, event.message);
            this.clearActiveStream(chatId, generation);
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
      const message = String(error);
      if (this.shouldSuppressStreamError(chatId, generation, message)) {
        const interruptedChat = await this.loadChatIfAvailable(chatId);
        if (interruptedChat && (interruptedChat.state.status === "interrupting" || interruptedChat.state.interruptRequested)) {
          await this.completeInterruptedChat(interruptedChat);
        }
        return;
      }
      chat = await this.loadChatIfAvailable(chatId);
      if (chat && this.isActiveStreamGeneration(chatId, generation)) {
        await this.emitChatError(chat, message);
      }
    } finally {
      eventStream.close();
      this.clearActiveStream(chatId, generation);
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

  private findMessage(chat: Chat, messageId?: string): MessageData | undefined {
    if (!messageId) {
      return undefined;
    }
    return chat.state.messages.find((message) => message.id === messageId);
  }

  private createResponseSegmentMessageId(turnMessageId: string | null, segmentCount: number): string {
    if (!turnMessageId) {
      return `chat-assistant-${crypto.randomUUID()}`;
    }
    return segmentCount === 1 ? turnMessageId : `${turnMessageId}-segment-${segmentCount}`;
  }

  private async updateStreamingAssistantProgress(
    chat: Chat,
    {
      messageId,
      content,
      responseLogId,
      responseLogContent,
      timestamp,
      activityTimestamp,
    }: {
      messageId: string | null;
      content: string;
      responseLogId: string | null;
      responseLogContent: string;
      timestamp: string;
      activityTimestamp: string;
    },
  ): Promise<{ chat: Chat; messageId: string; responseLogId: string }> {
    const existingMessage = this.findMessage(chat, messageId ?? undefined);
    const existingLog = responseLogId
      ? chat.state.logs.find((logEntry) => logEntry.id === responseLogId)
      : undefined;
    const nextMessageId = existingMessage?.id
      ?? messageId
      ?? `chat-assistant-${crypto.randomUUID()}`;
    const assistantMessage: MessageData = {
      id: nextMessageId,
      role: "assistant",
      content,
      timestamp: existingMessage?.timestamp ?? timestamp,
    };
    const responseLog: LoopLogEntry = {
      id: responseLogId ?? `chat-log-${crypto.randomUUID()}`,
      level: "agent",
      message: "AI generating response...",
      details: {
        logKind: "response",
        responseContent: responseLogContent,
      },
      timestamp: existingLog?.timestamp ?? timestamp,
    };
    const nextMessages = chat.state.messages.some((existing) => existing.id === assistantMessage.id)
      ? chat.state.messages.map((existing) => existing.id === assistantMessage.id ? assistantMessage : existing)
      : [...chat.state.messages, assistantMessage];
    const existingLogIndex = chat.state.logs.findIndex((logEntry) => logEntry.id === responseLog.id);
    const nextLogs = existingLogIndex >= 0
      ? chat.state.logs.map((logEntry, index) => index === existingLogIndex ? responseLog : logEntry)
      : [...chat.state.logs, responseLog];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      activeMessageId: nextMessageId,
      messages: nextMessages,
      logs: nextLogs,
      lastActivityAt: activityTimestamp,
    });
    this.emitter.emit({
      type: "chat.message",
      chatId: chat.config.id,
      message: assistantMessage,
      timestamp: activityTimestamp,
    });
    this.emitter.emit({
      type: "chat.log",
      chatId: chat.config.id,
      log: responseLog,
      timestamp: activityTimestamp,
    });
    return {
      chat: updated,
      messageId: nextMessageId,
      responseLogId: responseLog.id,
    };
  }

  private async emitChatLog(
    chat: Chat,
    level: LoopLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
    id?: string,
    timestamp?: string,
  ): Promise<Chat> {
    const existing = id
      ? chat.state.logs.find((logEntry) => logEntry.id === id)
      : undefined;
    const activityTimestamp = timestamp ?? createTimestamp();
    const entry: LoopLogEntry = {
      id: id ?? `chat-log-${crypto.randomUUID()}`,
      level,
      message,
      details,
      timestamp: existing?.timestamp ?? activityTimestamp,
    };
    const existingIndex = chat.state.logs.findIndex((logEntry) => logEntry.id === entry.id);
    const logs = existingIndex >= 0
      ? chat.state.logs.map((logEntry, index) => index === existingIndex ? entry : logEntry)
      : [...chat.state.logs, entry];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      logs,
      lastActivityAt: activityTimestamp,
    });
    this.emitter.emit({
      type: "chat.log",
      chatId: chat.config.id,
      log: entry,
      timestamp: activityTimestamp,
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

  private async completeInterruptedChat(chat: Chat): Promise<Chat> {
    const now = createTimestamp();
    const activeMessageId = chat.state.activeMessageId;
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      status: "idle",
      interruptRequested: false,
      completedAt: undefined,
      activeMessageId: undefined,
      messages: activeMessageId
        ? chat.state.messages.filter((message) => message.id !== activeMessageId)
        : chat.state.messages,
      lastActivityAt: now,
    });
    this.emitter.emit({
      type: "chat.interrupted",
      chatId: chat.config.id,
      timestamp: now,
    });
    return updated;
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

  private nextActiveStreamGeneration(chatId: string): number {
    const generation = (this.activeStreamGenerations.get(chatId) ?? 0) + 1;
    this.activeStreamGenerations.set(chatId, generation);
    return generation;
  }

  private isActiveStreamGeneration(chatId: string, generation: number): boolean {
    return this.activeStreams.get(chatId)?.generation === generation;
  }

  private clearActiveStream(chatId: string, generation: number): void {
    if (this.isActiveStreamGeneration(chatId, generation)) {
      this.activeStreams.delete(chatId);
    }
  }

  private shouldSuppressStreamError(chatId: string, generation: number, message: string): boolean {
    if (!this.isActiveStreamGeneration(chatId, generation)) {
      return true;
    }

    const normalized = message.toLowerCase();
    return normalized.includes("request cancelled")
      || normalized.includes("operation cancelled by user")
      || normalized.includes("prompt cancelled")
      || normalized.includes("session cancelled")
      || normalized.includes("useraborterror")
      || normalized.includes("aborterror")
      || normalized.includes("-32800");
  }

  private async updateChatStateAndReturn(chat: Chat, state: Chat["state"]): Promise<Chat> {
    const saved = await updateChatState(chat.config.id, state);
    if (!saved) {
      throw new Error(`Failed to persist chat state for ${chat.config.id}`);
    }
    const updated = {
      config: chat.config,
      state,
    };
    if (chat.state.status !== state.status) {
      this.emitter.emit({
        type: "chat.status",
        chatId: chat.config.id,
        status: state.status,
        timestamp: state.lastActivityAt ?? createTimestamp(),
      });
    }
    return updated;
  }

  private async loadChatIfAvailable(chatId: string): Promise<Chat | null> {
    try {
      return await loadChat(chatId);
    } catch (error) {
      if (isDatabaseNotInitializedError(error)) {
        return null;
      }
      throw error;
    }
  }
}

export const chatManager = new ChatManager();
