/**
 * Chat manager for long-lived ACP-backed chats.
 *
 * This is the initial runtime facade for chat CRUD and runtime metadata. It
 * owns chat records and event emission, and exposes dedicated backend hooks so
 * later API/runtime layers can bind ACP sessions without reaching directly into
 * persistence.
 */

import { AcpBackend } from "../backends/acp";
import type { Backend, BackendConnectionConfig, PromptInput, AgentEvent } from "../backends/types";
import type { Chat, ChatConfig, ChatStatus, ChatWorktreeState, Task, TaskLogEntry, MessageData, PersistedToolCall, SessionInfo } from "../types";
import type { ChatEvent } from "../types/events";
import { createTimestamp } from "../types/events";
import type { MessageImageAttachment } from "../types/message-attachments";
import type { EventStream } from "../utils/event-stream";
import {
  ChatBranchCheckoutError,
  ChatBusyError,
  ChatPermissionReplyError,
  ChatPermissionRequestNotFoundError,
  createInitialChatState,
  DEFAULT_CHAT_CONFIG,
  InvalidChatBaseBranchError,
  SshCredentialsRequiredError,
  isChatBusyStatus,
  isSshServerChat,
  isTaskChat,
  isStandaloneChat,
} from "../types/chat";
import type { ChatPermissionDecision, ChatPermissionRequest } from "../types/chat";
import {
  loadChat,
  loadTaskChat,
  listChats,
  listChatSummaries,
  listChatsByWorkspace,
  listChatSummariesByWorkspace,
  listChatSummariesBySshServer,
  saveChat,
  deleteChat,
  updateChatConfig,
  updateChatState,
  getWorkspaceChatNameStats,
} from "../persistence/chats";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import { backendManager, buildConnectionConfig } from "./backend";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { nextWithTimeout } from "./engine/engine-helpers";
import { isSessionNotFoundError } from "./engine/engine-session";
import { GitService, InvalidBranchNameError } from "./git";
import { syncMainCheckoutBeforeWorktree } from "./git/worktree-sync";
import { taskManager } from "./task-manager";
import { createLogger } from "./logger";
import { buildSeededPlanStatusContent, readValidatedPlanningFiles } from "./planning-file-service";
import { sanitizeBranchName } from "../utils";
import {
  buildSpawnCurrentPlanPrompt,
  buildSpawnTaskNameFromChat,
  buildSpawnTaskNameFromCurrentPlan,
  buildSpawnTaskPrompt,
} from "../utils/chat-to-task-prompt";
import { getImageViewToolPath, resolveToolCallImagePreview } from "./tool-call-image-preview";
import { mergeToolCallRecord, upsertToolCallExtra, type ToolCallExtra } from "../types/tool-call";
import { getTaskWorkingDirectory } from "./task/task-types";
import { sshCredentialManager } from "./ssh-credential-manager";
import { sshServerManager } from "./ssh-server-manager";
import { buildSshRemoteShellCommand } from "./remote-command-executor";
import { buildSshProcessConfig, getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { getProviderAcpCommand } from "./agent-runtime-command";
import type { AgentProvider } from "../types/settings";

const log = createLogger("chat-manager");
const DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const DATABASE_NOT_INITIALIZED_MESSAGE = "Database not initialized. Call initializeDatabase() first.";

interface ActiveChatStream {
  stream: EventStream<AgentEvent>;
  promptPromise: Promise<void>;
  generation: number;
}

interface ResolvedChatDirectory {
  chat: Chat;
  directory: string;
}

function isDatabaseNotInitializedError(error: unknown): boolean {
  return error instanceof Error && error.message === DATABASE_NOT_INITIALIZED_MESSAGE;
}

export interface CreateChatOptions {
  name?: string;
  workspaceId: string;
  scope?: ChatConfig["scope"];
  taskId?: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  useWorktree?: boolean;
  autoApprovePermissions?: boolean;
  baseBranch?: string;
  directory?: string;
  syncBaseBranch?: boolean;
  prepareWorktreeOnCreate?: boolean;
}

export interface CreateSshServerChatOptions {
  name?: string;
  sshServerId: string;
  directory: string;
  modelProviderID: string;
  modelID: string;
  modelVariant?: string;
  autoApprovePermissions?: boolean;
  credentialToken?: string | null;
}

export interface ReconnectChatOptions {
  credentialToken?: string | null;
}

function buildGeneratedChatName(projectName: string, nextSuffix: number): string {
  const suffix = ` - ${nextSuffix}`;
  const fallbackPrefix = "Chat";
  const trimmedProjectName = projectName.trim() || fallbackPrefix;
  const maxPrefixLength = Math.max(1, 100 - suffix.length);
  return `${trimmedProjectName.slice(0, maxPrefixLength).trim() || fallbackPrefix}${suffix}`;
}

export class ChatManager {
  private readonly activeStreams = new Map<string, ActiveChatStream>();
  private readonly activeStreamGenerations = new Map<string, number>();
  private readonly pendingWorktreePreparations = new Map<string, Promise<Chat>>();
  private readonly sshChatBackends = new Map<string, Backend>();

  constructor(private readonly emitter: SimpleEventEmitter<ChatEvent> = chatEventEmitter) {}

  async createChat(options: CreateChatOptions): Promise<Chat> {
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }

    const scope = options.scope ?? DEFAULT_CHAT_CONFIG.scope;
    if (scope === "task" && !options.taskId) {
      throw new Error("Task chats require a taskId");
    }
    if (scope === "workspace" && options.taskId) {
      throw new Error("Standalone chats cannot specify a taskId");
    }

    const id = crypto.randomUUID();
    const now = createTimestamp();
    const explicitName = options.name?.trim() ?? "";
    const generatedNamePrefix = (workspace.name.trim() || "Chat").slice(0, 100).trim() || "Chat";
    const chatNameStats = explicitName
      ? null
      : await getWorkspaceChatNameStats(options.workspaceId, generatedNamePrefix);
    const nextGeneratedSuffix = chatNameStats
      ? Math.max(chatNameStats.standaloneChatCount + 1, chatNameStats.maxGeneratedSuffix + 1)
      : 1;
    const name = explicitName || buildGeneratedChatName(workspace.name, nextGeneratedSuffix);
    const chat: Chat = {
      config: {
        id,
        name,
        workspaceId: options.workspaceId,
        source: {
          kind: "workspace",
          workspaceId: options.workspaceId,
        },
        scope,
        taskId: options.taskId,
        directory: options.directory ?? workspace.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant ?? "",
        },
        useWorktree: scope === "task" ? false : (options.useWorktree ?? DEFAULT_CHAT_CONFIG.useWorktree),
        autoApprovePermissions: options.autoApprovePermissions ?? DEFAULT_CHAT_CONFIG.autoApprovePermissions,
        skipBaseBranchSync: options.syncBaseBranch === false,
        baseBranch: options.baseBranch,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: createInitialChatState(id),
    };

    const shouldPrepareWorktreeOnCreate =
      !isTaskChat(chat) && chat.config.useWorktree && (options.prepareWorktreeOnCreate ?? true);
    const preparedChat = shouldPrepareWorktreeOnCreate
      ? {
          ...chat,
          state: {
            ...chat.state,
            worktree: await this.prepareWorktreeState(chat, {
              syncBaseBranch: options.syncBaseBranch ?? true,
            }),
            lastActivityAt: chat.state.lastActivityAt ?? createTimestamp(),
          },
        }
      : chat;

    await saveChat(preparedChat);
    this.emitter.emit({
      type: "chat.created",
      chatId: id,
      config: preparedChat.config,
      timestamp: now,
    });
    if (!shouldPrepareWorktreeOnCreate && !isTaskChat(preparedChat) && preparedChat.config.useWorktree) {
      this.prepareWorktreeInBackground(preparedChat);
    }
    return preparedChat;
  }

  async createSshServerChat(options: CreateSshServerChatOptions): Promise<Chat> {
    const server = await sshServerManager.getServer(options.sshServerId);
    if (!server) {
      throw new Error(`SSH server not found: ${options.sshServerId}`);
    }

    const id = crypto.randomUUID();
    const now = createTimestamp();
    const explicitName = options.name?.trim() ?? "";
    const name = explicitName || `${server.config.name} chat`;
    const session = await sshServerManager.createSession(options.sshServerId, {
      name: `Chat transport: ${name}`.slice(0, 100),
      credentialToken: null,
      connectionMode: "dtach",
    });
    const chat: Chat = {
      config: {
        id,
        name,
        workspaceId: "",
        source: {
          kind: "ssh_server",
          sshServerId: options.sshServerId,
          sshServerSessionId: session.config.id,
          directory: options.directory,
        },
        scope: "workspace",
        directory: options.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant ?? "",
        },
        useWorktree: false,
        autoApprovePermissions: options.autoApprovePermissions ?? DEFAULT_CHAT_CONFIG.autoApprovePermissions,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: {
        ...createInitialChatState(id),
        connectionStatus: "needs_credentials",
      },
    };

    await saveChat(chat);
    this.emitter.emit({
      type: "chat.created",
      chatId: id,
      config: chat.config,
      timestamp: now,
    });

    if (options.credentialToken?.trim()) {
      const reconnected = await this.reconnectSession(id, { credentialToken: options.credentialToken });
      if (!reconnected) {
        throw new Error(`Failed to reconnect created SSH-server chat: ${id}`);
      }
      return reconnected;
    }
    return chat;
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return loadChat(chatId);
  }

  async getAllChats(): Promise<Chat[]> {
    return (await listChats()).filter(isStandaloneChat);
  }

  async getChatSummaries(): Promise<Chat[]> {
    return (await listChatSummaries()).filter(isStandaloneChat);
  }

  async getChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
    return (await listChatsByWorkspace(workspaceId)).filter(isStandaloneChat);
  }

  async getChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]> {
    return (await listChatSummariesByWorkspace(workspaceId)).filter(isStandaloneChat);
  }

  async getChatSummariesBySshServer(sshServerId: string): Promise<Chat[]> {
    return (await listChatSummariesBySshServer(sshServerId)).filter(isStandaloneChat);
  }

  async getTaskChat(taskId: string): Promise<Chat | null> {
    return loadTaskChat(taskId);
  }

  async getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }> {
    const existing = await this.getTaskChat(taskId);
    if (existing) {
      return { chat: existing, created: false };
    }

    const targetTask = task ?? await taskManager.getTask(taskId);
    if (!targetTask) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const workingDirectory = getTaskWorkingDirectory(targetTask);
    if (!workingDirectory) {
      throw new Error(`Task ${taskId} does not currently have a working directory for chat creation`);
    }

    try {
      const chat = await this.createChat({
        name: targetTask.config.name,
        workspaceId: targetTask.config.workspaceId,
        scope: "task",
        taskId,
        modelProviderID: targetTask.config.model.providerID,
        modelID: targetTask.config.model.modelID,
        modelVariant: targetTask.config.model.variant,
        useWorktree: false,
        baseBranch: targetTask.config.baseBranch,
        directory: workingDirectory,
      });
      return { chat, created: true };
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: chats.task_id")) {
        const concurrent = await this.getTaskChat(taskId);
        if (concurrent) {
          return { chat: concurrent, created: false };
        }
      }
      throw error;
    }
  }

  async deleteTaskChat(taskId: string): Promise<boolean> {
    const chat = await this.getTaskChat(taskId);
    if (!chat) {
      return false;
    }
    return this.deleteChat(chat.config.id);
  }

  async updateChat(
    chatId: string,
    updates: Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId">>,
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

  async reconnectSession(chatId: string, options: ReconnectChatOptions = {}): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const backend = await this.ensureBackendConnected(chat, options);
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

    const activeStream = this.activeStreams.get(chatId);
    if (activeStream) {
      activeStream.stream.close();
      this.activeStreams.delete(chatId);
    }

    try {
      await backend.abortSession(chat.state.session.id);
    } catch (error) {
      log.warn("Failed to abort chat session during interrupt", {
        chatId,
        sessionId: chat.state.session.id,
        error: String(error),
      });
    }

    if (activeStream) {
      try {
        await this.disconnectChat(chatId);
      } catch (error) {
        log.warn("Failed to disconnect chat backend during interrupt", {
          chatId,
          error: String(error),
        });
      }
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
    return this.completeInterruptedChat(interrupted);
  }

  async replyToPermission(chatId: string, requestId: string, decision: ChatPermissionDecision): Promise<Chat | null> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return null;
    }

    const request = (chat.state.pendingPermissionRequests ?? []).find(
      (permissionRequest) => permissionRequest.requestId === requestId && permissionRequest.status === "pending",
    );
    if (!request) {
      throw new ChatPermissionRequestNotFoundError(requestId);
    }

    const backend = this.getChatBackend(chat.config.id, chat.config.workspaceId);
    if (!backend.isConnected()) {
      throw new ChatPermissionReplyError(`Cannot reply to permission request ${requestId}: chat backend is not connected`);
    }

    const reply = decision === "allow" ? "once" : "deny";
    try {
      await backend.replyToPermission(requestId, reply);
    } catch (error) {
      const failed = await this.updatePermissionRequest(chat, requestId, {
        status: "pending",
        error: String(error),
      });
      this.emitChatUpdated(failed);
      throw new ChatPermissionReplyError(`Failed to reply to permission request ${requestId}: ${String(error)}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    const updated = await this.updatePermissionRequest(chat, requestId, {
      status: decision === "allow" ? "approved" : "denied",
      decision,
      resolvedAt: createTimestamp(),
      error: undefined,
    });
    this.emitChatUpdated(updated);
    await this.emitChatLog(
      updated,
      "info",
      decision === "allow" ? "Permission request approved" : "Permission request denied",
      { requestId, permission: request.permission, patterns: request.patterns },
    );
    return await loadChat(chatId) ?? updated;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const chat = await loadChat(chatId);
    if (!chat) {
      return false;
    }
    const internalSshServerSessionId = chat.config.source?.kind === "ssh_server"
      ? chat.config.source.sshServerSessionId
      : null;

    this.activeStreams.get(chatId)?.stream.close();
    this.activeStreams.delete(chatId);
    this.activeStreamGenerations.delete(chatId);
    await this.disconnectChat(chatId);
    await this.cleanupWorktree(chat);

    const deleted = await deleteChat(chatId);
    if (deleted) {
      if (internalSshServerSessionId) {
        const internalSession = await sshServerManager.getSession(internalSshServerSessionId);
        if (internalSession) {
          await sshServerManager.deleteInternalSessionRecord(internalSshServerSessionId);
        } else {
          log.warn("SSH-server chat transport session was already missing during chat deletion", {
            chatId,
            sshServerSessionId: internalSshServerSessionId,
          });
        }
      }
      this.emitter.emit({
        type: "chat.deleted",
        chatId,
        scope: chat.config.scope,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }

  async spawnTaskFromChat(chatId: string): Promise<Task> {
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

    const prompt = buildSpawnTaskPrompt(chat.config.name, chat.state.messages);

    await touchWorkspace(chat.config.workspaceId);

    const task = await taskManager.createTask({
      name: buildSpawnTaskNameFromChat(chat.config.name, chat.state.messages),
      directory: chat.config.directory,
      prompt,
      workspaceId: chat.config.workspaceId,
      modelProviderID: chat.config.model.providerID,
      modelID: chat.config.model.modelID,
      modelVariant: chat.config.model.variant,
      baseBranch,
      useWorktree: chat.config.useWorktree,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
    });

    try {
      await taskManager.startPlanMode(task.config.id);
      await taskManager.saveLastUsedModel(chat.config.model);
    } catch (error) {
      try {
        await taskManager.deleteTask(task.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned task after plan-mode start failure", {
          taskId: task.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to start spawned task in plan mode", { cause: error });
    }

    return await taskManager.getTask(task.config.id) ?? task;
  }

  async spawnTaskFromCurrentPlan(chatId: string, planFilePath?: string): Promise<Task> {
    const chat = await loadChat(chatId);
    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    this.assertChatIsAvailable(chat);

    const working = await this.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.hasEstablishedWorkspaceContext(chat),
    });
    const workingExecutor = await backendManager.getCommandExecutorAsync(
      working.chat.config.workspaceId,
      working.directory,
    );
    const currentPlan = await readValidatedPlanningFiles(workingExecutor, working.directory, planFilePath);

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const baseBranch = working.chat.state.worktree?.originalBranch
      ?? working.chat.config.baseBranch
      ?? await git.getDefaultBranch(working.chat.config.directory);

    const prompt = buildSpawnCurrentPlanPrompt();

    await touchWorkspace(working.chat.config.workspaceId);

    const task = await taskManager.createTask({
      name: buildSpawnTaskNameFromCurrentPlan(
        working.chat.config.name,
        working.chat.state.messages,
        currentPlan.planContent,
      ),
      directory: working.chat.config.directory,
      prompt,
      workspaceId: working.chat.config.workspaceId,
      modelProviderID: working.chat.config.model.providerID,
      modelID: working.chat.config.model.modelID,
      modelVariant: working.chat.config.model.variant,
      baseBranch,
      useWorktree: working.chat.config.useWorktree,
      planMode: true,
      autoAcceptPlan: false,
      fullyAutonomous: false,
    });

    try {
      await taskManager.seedPlanFiles(task.config.id, {
        planContent: currentPlan.planContent,
        statusContent: currentPlan.statusContent ?? buildSeededPlanStatusContent(task.config.name),
      });
      await taskManager.saveLastUsedModel(working.chat.config.model);
    } catch (error) {
      try {
        await taskManager.deleteTask(task.config.id);
      } catch (cleanupError) {
        log.warn("Failed to clean up spawned task after current-plan seed failure", {
          taskId: task.config.id,
          chatId,
          error: String(cleanupError),
        });
      }
      throw new Error("Failed to seed spawned task from the current plan", { cause: error });
    }

    return await taskManager.getTask(task.config.id) ?? task;
  }

  getChatBackend(chatId: string, workspaceId: string): Backend {
    return backendManager.getChatBackend(chatId, workspaceId);
  }

  async disconnectChat(chatId: string): Promise<void> {
    const sshBackend = this.sshChatBackends.get(chatId);
    let sshDisconnectError: unknown;
    if (sshBackend) {
      try {
        sshBackend.abortAllSubscriptions();
        if (sshBackend.isConnected()) {
          await sshBackend.disconnect();
        }
      } catch (error) {
        sshDisconnectError = error;
        log.error("Failed to disconnect SSH chat backend", { chatId, error: String(error) });
      } finally {
        this.sshChatBackends.delete(chatId);
      }
    }
    await backendManager.disconnectChat(chatId);
    if (sshDisconnectError) {
      throw sshDisconnectError;
    }
  }

  private assertChatIsAvailable(chat: Chat): void {
    if (isChatBusyStatus(chat.state.status)) {
      throw new ChatBusyError();
    }
  }

  private hasEstablishedWorkspaceContext(chat: Chat): boolean {
    return Boolean(chat.state.session?.id || chat.state.startedAt);
  }

  private async ensureBackendConnected(chat: Chat, options: ReconnectChatOptions = {}): Promise<Backend> {
    if (isSshServerChat(chat)) {
      return this.ensureSshServerBackendConnected(chat, options);
    }

    const workspace = await getWorkspace(chat.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const working = await this.resolveWorkingDirectory(chat, {
      prepareWorkspace: !this.hasEstablishedWorkspaceContext(chat),
    });
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

  private getOrCreateSshChatBackend(chatId: string): Backend {
    const existing = this.sshChatBackends.get(chatId);
    if (existing) {
      return existing;
    }
    const backend = new AcpBackend();
    this.sshChatBackends.set(chatId, backend);
    return backend;
  }

  private async ensureSshServerBackendConnected(chat: Chat, options: ReconnectChatOptions): Promise<Backend> {
    const source = chat.config.source;
    if (source?.kind !== "ssh_server") {
      throw new Error(`Chat is not SSH-server backed: ${chat.config.id}`);
    }

    const backend = this.getOrCreateSshChatBackend(chat.config.id);
    const directory = source.directory || chat.config.directory;
    if (backend.isConnected() && backend.getDirectory() === directory) {
      return backend;
    }

    const credentialToken = options.credentialToken?.trim();
    if (!credentialToken) {
      await this.markSshCredentialsRequired(chat);
      throw new SshCredentialsRequiredError();
    }

    const connectingChat = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      connectionStatus: "connecting",
      lastActivityAt: createTimestamp(),
    });

    let password: string;
    try {
      password = sshCredentialManager.getPasswordForToken(source.sshServerId, credentialToken);
    } catch (error) {
      await this.markSshCredentialsRequired(connectingChat, String(error));
      throw new SshCredentialsRequiredError(String(error), {
        cause: error instanceof Error ? error : undefined,
      });
    }

    let config: BackendConnectionConfig;
    try {
      config = await this.buildSshChatConnectionConfig(connectingChat, password);
    } catch (error) {
      await this.markSshConnectionFailed(connectingChat, error);
      throw error;
    }

    if (backend.isConnected()) {
      await backend.disconnect();
    }

    try {
      await backend.connect(config);
      await this.updateChatStateAndReturn(connectingChat, {
        ...connectingChat.state,
        connectionStatus: "connected",
        lastActivityAt: createTimestamp(),
      });
      return backend;
    } catch (error) {
      await this.markSshConnectionFailed(connectingChat, error);
      throw error;
    }
  }

  private async markSshCredentialsRequired(
    chat: Chat,
    message = "SSH credentials are required to reconnect this chat",
  ): Promise<void> {
    await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      connectionStatus: "needs_credentials",
      error: {
        message,
        timestamp: createTimestamp(),
        code: "ssh_credentials_required",
      },
      lastActivityAt: createTimestamp(),
    });
  }

  private async markSshConnectionFailed(chat: Chat, error: unknown): Promise<void> {
    await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      connectionStatus: "ssh_connection_failed",
      error: {
        message: String(error),
        timestamp: createTimestamp(),
        code: "ssh_connection_failed",
      },
      lastActivityAt: createTimestamp(),
    });
  }

  private async buildSshChatConnectionConfig(chat: Chat, password: string): Promise<BackendConnectionConfig> {
    const source = chat.config.source;
    if (source?.kind !== "ssh_server") {
      throw new Error(`Chat is not SSH-server backed: ${chat.config.id}`);
    }
    const provider = chat.config.model.providerID;
    if (provider !== "opencode" && provider !== "copilot") {
      throw new Error(`Unsupported SSH chat provider: ${provider}`);
    }
    const providerCommand = getProviderAcpCommand(provider as AgentProvider, "ssh");
    const providerInvocation = [providerCommand.command, ...providerCommand.args].join(" ");
    const directory = source.directory || chat.config.directory;

    return {
      mode: "spawn",
      provider: provider as AgentProvider,
      transport: "ssh",
      directory,
      ...await this.buildSshChatProcessConfig(source.sshServerId, password, providerInvocation, directory),
    };
  }

  private async buildSshChatProcessConfig(
    sshServerId: string,
    password: string,
    providerInvocation: string,
    directory: string,
  ): Promise<Pick<BackendConnectionConfig, "hostname" | "port" | "username" | "password" | "identityFile" | "command" | "args" | "env">> {
    const { server } = await sshServerManager.getCommandExecutor(sshServerId, password);
    const target = getSshConnectionTargetFromServer(server, password);
    const processConfig = buildSshProcessConfig({
      target,
      remoteCommand: buildSshRemoteShellCommand(providerInvocation),
      connectionScope: directory,
      passwordHandling: "environment",
    });
    return {
      hostname: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      identityFile: target.identityFile,
      command: processConfig.command,
      args: processConfig.args,
      env: processConfig.env,
    };
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

    return this.createSession(chat, backend, {
      prepareWorkspace: !this.hasEstablishedWorkspaceContext(chat),
    });
  }

  private async createSession(
    chat: Chat,
    backend: Backend,
    options: { prepareWorkspace: boolean },
  ): Promise<Chat> {
    const working = await this.resolveWorkingDirectory(chat, options);
    const session = await backend.createSession({
      title: `Clanky Chat: ${working.chat.config.name}`,
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
      return await this.createSession(reconnecting, backend, { prepareWorkspace: false });
    } catch (error) {
      await this.emitChatError(reconnecting, String(error));
      throw error;
    }
  }

  private async resolveWorkingDirectory(
    chat: Chat,
    options: { prepareWorkspace: boolean },
  ): Promise<ResolvedChatDirectory> {
    if (isTaskChat(chat)) {
      const taskId = chat.config.taskId;
      if (!taskId) {
        throw new Error(`Task chat ${chat.config.id} is missing its taskId`);
      }
      const task = await taskManager.getTask(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} for chat ${chat.config.id} was not found`);
      }
      const directory = getTaskWorkingDirectory(task);
      if (!directory) {
        throw new Error(`Task ${taskId} does not currently have a working directory for chat ${chat.config.id}`);
      }
      return { chat, directory };
    }

    if (!chat.config.useWorktree) {
      if (options.prepareWorkspace) {
        await this.ensureStandaloneChatBranch(chat);
      }
      return {
        chat,
        directory: chat.config.directory,
      };
    }

    if (!options.prepareWorkspace) {
      const worktreePath = chat.state.worktree?.worktreePath;
      if (!worktreePath) {
        throw new Error(
          `Chat ${chat.config.id} is configured to use a worktree but no established worktree path was recorded`,
        );
      }
      return {
        chat,
        directory: worktreePath,
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

  private async ensureStandaloneChatBranch(chat: Chat): Promise<void> {
    if (isTaskChat(chat) || chat.config.useWorktree) {
      return;
    }

    const expectedBranch = chat.config.baseBranch?.trim();
    if (!expectedBranch) {
      return;
    }

    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const isGitRepo = await git.isGitRepo(chat.config.directory);
    if (!isGitRepo) {
      return;
    }

    try {
      await git.assertValidBranchName(chat.config.directory, expectedBranch);
    } catch (error) {
      if (error instanceof InvalidBranchNameError) {
        throw new InvalidChatBaseBranchError(expectedBranch);
      }
      throw error;
    }

    let result;
    try {
      result = await git.ensureBranch(chat.config.directory, expectedBranch, {
        autoCheckout: true,
      });
    } catch (error) {
      throw new ChatBranchCheckoutError(
        expectedBranch,
        `Unable to switch the standalone chat to branch '${expectedBranch}'. ${String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (result.checkedOut) {
      log.info("[ChatManager] Checked out selected branch for standalone chat", {
        chatId: chat.config.id,
        fromBranch: result.currentBranch,
        toBranch: result.expectedBranch,
      });
    }
  }

  private async ensureWorktree(chat: Chat): Promise<Chat> {
    if (isTaskChat(chat)) {
      return chat;
    }

    if (!chat.config.useWorktree) {
      return chat;
    }

    const pendingPreparation = this.pendingWorktreePreparations.get(chat.config.id);
    if (pendingPreparation) {
      return pendingPreparation;
    }

    return this.prepareAndPersistWorktree(chat);
  }

  private prepareWorktreeInBackground(chat: Chat): void {
    void this.prepareAndPersistWorktree(chat).catch((error) => {
      log.warn("[ChatManager] Deferred chat worktree preparation failed", {
        chatId: chat.config.id,
        error: String(error),
      });
    });
  }

  private prepareAndPersistWorktree(chat: Chat): Promise<Chat> {
    const existing = this.pendingWorktreePreparations.get(chat.config.id);
    if (existing) {
      return existing;
    }

    const preparation = this.doPrepareAndPersistWorktree(chat).finally(() => {
      if (this.pendingWorktreePreparations.get(chat.config.id) === preparation) {
        this.pendingWorktreePreparations.delete(chat.config.id);
      }
    });
    this.pendingWorktreePreparations.set(chat.config.id, preparation);
    return preparation;
  }

  private async doPrepareAndPersistWorktree(chat: Chat): Promise<Chat> {
    const nextWorktreeState = await this.prepareWorktreeState(chat, {
      syncBaseBranch: !chat.config.skipBaseBranchSync,
    });
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

  private async prepareWorktreeState(
    chat: Chat,
    options: { syncBaseBranch?: boolean } = {},
  ): Promise<ChatWorktreeState> {
    const executor = await backendManager.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const originalBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getCurrentBranch(chat.config.directory);
    const workingBranch = chat.state.worktree?.workingBranch
      ?? this.buildWorkingBranchName(chat);
    const worktreePath = chat.state.worktree?.worktreePath
      ?? `${chat.config.directory}/.clanky-worktrees/${chat.config.id}`;

    const worktreeExists = await git.worktreeExists(chat.config.directory, worktreePath);
    if (!worktreeExists) {
      if (options.syncBaseBranch ?? true) {
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
      }

      const branchExists = await git.branchExists(chat.config.directory, workingBranch);
      if (branchExists) {
        await git.addWorktreeForExistingBranch(chat.config.directory, worktreePath, workingBranch);
      } else {
        await git.createWorktree(chat.config.directory, worktreePath, workingBranch, originalBranch);
      }
    }

    return {
      originalBranch,
      workingBranch,
      worktreePath,
    };
  }

  private async cleanupWorktree(chat: Chat): Promise<void> {
    if (isTaskChat(chat)) {
      return;
    }

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
      connectionStatus: isSshServerChat(chat) ? "connected" : chat.state.connectionStatus,
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
    void this.consumeEventStream(chat.config.id, backend, eventStream, promptPromise, generation);
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
    backend: Backend,
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
            const toolId = event.toolCallId ?? `chat-tool-${crypto.randomUUID()}`;
            const toolKey = event.toolCallId ?? event.toolName;
            toolInputs.set(toolKey, event.input);
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
            const toolCallId = event.toolCallId;
            const toolKey = toolCallId ?? toolName;
            const existing = toolCallId
              ? chat.state.toolCalls.find((tool) => tool.id === toolCallId)
              : [...chat.state.toolCalls].reverse().find((tool) => tool.name === toolName);
            const completedInput = event.input ?? existing?.input ?? toolInputs.get(toolKey);
            const completedToolId = toolCallId ?? existing?.id ?? `chat-tool-${crypto.randomUUID()}`;
            toolInputs.set(toolKey, completedInput);
            chat = await this.upsertToolCall(chat, {
              id: completedToolId,
              name: toolName,
              input: completedInput,
              output: event.output,
              status: "completed",
              timestamp: now,
            });
            this.scheduleToolImagePreview(chat.config.id, {
              id: completedToolId,
              name: toolName,
              input: completedInput,
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
            if (isInterrupted) {
              break;
            }
            chat = await this.handlePermissionAsked(chat, backend, {
              requestId: event.requestId,
              sessionId: event.sessionId,
              permission: event.permission,
              patterns: event.patterns,
              status: "pending",
              createdAt: now,
            });
            break;

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
    const responseLog: TaskLogEntry = {
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
    level: TaskLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
    id?: string,
    timestamp?: string,
  ): Promise<Chat> {
    const existing = id
      ? chat.state.logs.find((logEntry) => logEntry.id === id)
      : undefined;
    const activityTimestamp = timestamp ?? createTimestamp();
    const entry: TaskLogEntry = {
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

  private async handlePermissionAsked(
    chat: Chat,
    backend: Backend,
    request: ChatPermissionRequest,
  ): Promise<Chat> {
    if (chat.config.autoApprovePermissions !== false) {
      const logged = await this.emitChatLog(chat, "info", `Auto-approving permission request: ${request.permission}`, {
        requestId: request.requestId,
        patterns: request.patterns,
      });
      try {
        await backend.replyToPermission(request.requestId, "always");
      } catch (error) {
        return this.emitChatError(logged, `Failed to approve permission request ${request.permission}: ${String(error)}`);
      }
      return this.emitChatLog(logged, "info", "Permission approved successfully", {
        requestId: request.requestId,
      });
    }

    const updated = await this.upsertPermissionRequest(chat, request);
    this.emitChatUpdated(updated);
    return this.emitChatLog(updated, "info", `Permission approval required: ${request.permission}`, {
      requestId: request.requestId,
      patterns: request.patterns,
    });
  }

  private async upsertPermissionRequest(chat: Chat, request: ChatPermissionRequest): Promise<Chat> {
    const existingRequests = chat.state.pendingPermissionRequests ?? [];
    const existingIndex = existingRequests.findIndex(
      (permissionRequest) => permissionRequest.requestId === request.requestId,
    );
    const requests = existingIndex >= 0
      ? existingRequests.map((permissionRequest, index) =>
        index === existingIndex ? { ...permissionRequest, ...request } : permissionRequest
      )
      : [...existingRequests, request];

    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      pendingPermissionRequests: requests,
      lastActivityAt: request.createdAt,
    });
  }

  private async updatePermissionRequest(
    chat: Chat,
    requestId: string,
    updates: Partial<ChatPermissionRequest>,
  ): Promise<Chat> {
    const requests = (chat.state.pendingPermissionRequests ?? []).map((request) =>
      request.requestId === requestId ? { ...request, ...updates } : request
    );
    return this.updateChatStateAndReturn(chat, {
      ...chat.state,
      pendingPermissionRequests: requests,
      lastActivityAt: createTimestamp(),
    });
  }

  private emitChatUpdated(chat: Chat): void {
    this.emitter.emit({
      type: "chat.updated",
      chatId: chat.config.id,
      chat,
      timestamp: chat.state.lastActivityAt ?? createTimestamp(),
    });
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
    const persistedTool = existingIndex >= 0
      ? mergeToolCallRecord(chat.state.toolCalls[existingIndex], tool)
      : tool;
    const toolCalls = existingIndex >= 0
      ? chat.state.toolCalls.map((existing, index) => index === existingIndex ? persistedTool : existing)
      : [...chat.state.toolCalls, tool];
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      toolCalls,
      lastActivityAt: tool.timestamp,
    });
    this.emitter.emit({
      type: "chat.tool_call",
      chatId: chat.config.id,
      tool: persistedTool,
      timestamp: tool.timestamp,
    });
    return updated;
  }

  private async appendToolCallExtra(
    chat: Chat,
    toolId: string,
    extra: ToolCallExtra,
    timestamp = createTimestamp(),
  ): Promise<Chat> {
    const toolCalls = chat.state.toolCalls.map((toolCall) => (
      toolCall.id === toolId
        ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, extra) }
        : toolCall
    ));
    const updated = await this.updateChatStateAndReturn(chat, {
      ...chat.state,
      toolCalls,
      lastActivityAt: timestamp,
    });
    this.emitter.emit({
      type: "chat.tool_call.extra",
      chatId: chat.config.id,
      toolId,
      extra,
      timestamp,
    });
    return updated;
  }

  private scheduleToolImagePreview(chatId: string, tool: PersistedToolCall): void {
    const path = getImageViewToolPath(tool.name, tool.input);
    if (!path) {
      return;
    }

    // Resolve previews in the background so the main chat stream is not blocked.
    void (async () => {
      try {
        const currentChat = await this.loadChatIfAvailable(chatId);
        if (!currentChat) {
          return;
        }
        const directory = currentChat.state.worktree?.worktreePath ?? currentChat.config.directory;
        const extra = await resolveToolCallImagePreview({
          workspaceId: currentChat.config.workspaceId,
          directory,
          path,
          toolCallId: tool.id,
        });
        if (!extra) {
          return;
        }
        const latestChat = await this.loadChatIfAvailable(chatId);
        if (!latestChat || !latestChat.state.toolCalls.some((toolCall) => toolCall.id === tool.id)) {
          return;
        }
        await this.appendToolCallExtra(latestChat, tool.id, extra);
      } catch (error) {
        log.debug("Skipping chat tool image preview generation", {
          chatId,
          toolId: tool.id,
          error: String(error),
        });
      }
    })();
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
      pendingPermissionRequests: this.resolvePendingPermissionRequests(chat.state.pendingPermissionRequests ?? [], {
        status: "cancelled",
        resolvedAt: now,
        error: message,
      }),
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: now,
    });
    this.emitter.emit({
      type: "chat.error",
      chatId: chat.config.id,
      scope: chat.config.scope,
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
      pendingPermissionRequests: this.resolvePendingPermissionRequests(chat.state.pendingPermissionRequests ?? [], {
        status: "cancelled",
        resolvedAt: now,
        error: "Interrupted",
      }),
      toolCalls: chat.state.toolCalls.map((toolCall) =>
        toolCall.status === "running" || toolCall.status === "pending"
          ? {
              ...toolCall,
              status: "failed",
              output: toolCall.output ?? "Interrupted",
            }
          : toolCall
      ),
      messages: activeMessageId
        ? chat.state.messages.filter((message) => message.id !== activeMessageId)
        : chat.state.messages,
      lastActivityAt: now,
    });
    this.emitter.emit({
      type: "chat.interrupted",
      chatId: chat.config.id,
      scope: chat.config.scope,
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

  private resolvePendingPermissionRequests(
    requests: ChatPermissionRequest[],
    updates: Pick<ChatPermissionRequest, "status" | "resolvedAt" | "decision" | "error">,
  ): ChatPermissionRequest[] {
    return requests.map((request) =>
      request.status === "pending" ? { ...request, ...updates } : request
    );
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
        scope: chat.config.scope,
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
