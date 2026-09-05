/**
 * Chat creation, import, configuration, and deletion workflows.
 */

import type { Backend } from "../backends/types";
import type { Chat, ChatConfig, ChatStatus, SessionInfo, Task } from "@/shared";
import {
  DEFAULT_CHAT_CONFIG,
  createInitialChatState,
  ChatBusyError,
  ChatNotMarkableError,
  isChatBusyStatus,
  isStandaloneChat,
  isTaskChat,
  getChatWorkspaceId,
  isWorkspaceChat,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import { getTaskWorkingDirectory } from "./task/task-types";
import { taskManager, type TaskManager } from "./task-manager";
import { isUniqueConstraint } from "../persistence/errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { buildGeneratedChatName } from "./chat-name";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { createChatLatencyTimer } from "./chat-latency-instrumentation";
import { assertGitBackedWorkspace, isGitBackedWorkspace } from "./workspace-capabilities";
import type {
  ChatConfigUpdates,
  ChatConversationPort,
  DeleteChatOptions,
  ChatLifecyclePort,
  ChatSessionPort,
  ChatStatePort,
  ChatWorktreePort,
  CreateAgentRunChatOptions,
  CreateChatOptions,
  CreateExecutionHostChatOptions,
  ImportExistingSessionOptions,
} from "./chat-service-contracts";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";
import { executionHostService } from "./execution-host-service";

const log = createLogger("chat-lifecycle-service");

export interface ChatLifecycleServiceDependencies {
  state: ChatStatePort;
  worktree: ChatWorktreePort;
  session: ChatSessionPort;
  conversation: ChatConversationPort;
  taskManager: Pick<TaskManager, "getTask">;
}

export class ChatLifecycleService implements ChatLifecyclePort {
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly session: ChatSessionPort;
  private readonly conversation: ChatConversationPort;
  private readonly taskManager: Pick<TaskManager, "getTask">;

  constructor(dependencies: Partial<ChatLifecycleServiceDependencies> & Pick<
    ChatLifecycleServiceDependencies,
    "state" | "worktree" | "session" | "conversation"
  >) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.session = dependencies.session;
    this.conversation = dependencies.conversation;
    this.taskManager = dependencies.taskManager ?? taskManager;
  }

  async createChat(options: CreateChatOptions): Promise<Chat> {
    const timer = createChatLatencyTimer();
    const workspace = await timer.measure("workspace_lookup", () => this.state.getWorkspace(options.workspaceId));
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
    if (
      !isGitBackedWorkspace(workspace)
      && (
        scope === "task"
        || options.useWorktree === true
        || options.baseBranch !== undefined
      )
    ) {
      assertGitBackedWorkspace(
        workspace,
        "Directory workspaces do not support branches or worktrees.",
      );
    }

    const id = crypto.randomUUID();
    const now = createTimestamp();
    const explicitName = options.name?.trim() ?? "";
    const generatedNamePrefix = (workspace.name.trim() || "Chat").slice(0, 100).trim() || "Chat";
    const chatNameStats = explicitName
      ? null
      : await timer.measure("name_stats", () =>
          this.state.getWorkspaceChatNameStats(options.workspaceId, generatedNamePrefix)
        );
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
        executionHostBinding: workspace.executionHostBinding,
        scope,
        taskId: options.taskId,
        directory: options.directory ?? workspace.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant ?? "",
        },
        useWorktree: scope === "task"
          ? false
          : isGitBackedWorkspace(workspace)
            ? (options.useWorktree ?? DEFAULT_CHAT_CONFIG.useWorktree)
            : false,
        autoApprovePermissions: options.autoApprovePermissions ?? DEFAULT_CHAT_CONFIG.autoApprovePermissions,
        skipBaseBranchSync: options.syncBaseBranch === false,
        baseBranch: isGitBackedWorkspace(workspace) ? options.baseBranch : undefined,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: createInitialChatState(id),
    };

    const shouldPrepareWorktreeOnCreate =
      !isTaskChat(chat) && chat.config.useWorktree && (options.prepareWorktreeOnCreate ?? false);
    const initialChat = shouldPrepareWorktreeOnCreate || isTaskChat(chat) || !chat.config.useWorktree
      ? chat
      : {
          ...chat,
          state: {
            ...chat.state,
            startupStage: "preparing_workspace" as const,
          },
        };
    const preparedChat = shouldPrepareWorktreeOnCreate
      ? {
          ...initialChat,
          state: {
            ...initialChat.state,
            worktree: await timer.measure("worktree_preparation", () => this.worktree.prepareWorktreeState(initialChat, {
              syncBaseBranch: options.syncBaseBranch ?? true,
            })),
            startupStage: undefined,
            lastActivityAt: initialChat.state.lastActivityAt ?? createTimestamp(),
          },
        }
      : initialChat;

    await timer.measure("chat_persistence", () => this.state.saveNewChat(preparedChat));
    this.state.emitChatCreated(preparedChat, now);
    if (!shouldPrepareWorktreeOnCreate && !isTaskChat(preparedChat) && preparedChat.config.useWorktree) {
      this.worktree.prepareWorktreeInBackground(preparedChat);
    }
    const timing = timer.complete();
    log.info("Chat creation timing", {
      chatId: id,
      totalMs: timing.totalMs,
      stages: timing.stages,
      deferredWorktree: !shouldPrepareWorktreeOnCreate && preparedChat.config.useWorktree,
    });
    return preparedChat;
  }

  async createAgentRunChat(options: CreateAgentRunChatOptions): Promise<Chat> {
    return this.createChat({
      ...options,
      scope: "agent",
      autoApprovePermissions: true,
      prepareWorktreeOnCreate: options.prepareWorktreeOnCreate ?? true,
    });
  }

  async createExecutionHostChat(options: CreateExecutionHostChatOptions): Promise<Chat> {
    executionHostService.validateBinding(options.executionHost);
    const id = crypto.randomUUID();
    const now = createTimestamp();
    const chat: Chat = {
      config: {
        id,
        name: options.name?.trim() || `${options.executionHost.targetKey} chat`,
        source: {
          kind: "execution_host",
          executionHost: options.executionHost,
          directory: options.directory,
        },
        executionHostBinding: options.executionHost,
        scope: "workspace",
        directory: options.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant ?? "",
        },
        useWorktree: false,
        autoApprovePermissions: options.autoApprovePermissions
          ?? DEFAULT_CHAT_CONFIG.autoApprovePermissions,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: {
        ...createInitialChatState(id),
        connectionStatus: options.executionHost.host.kind === "ssh"
          ? "needs_credentials"
          : "disconnected",
      },
    };
    await this.state.saveNewChat(chat);
    this.state.emitChatCreated(chat, now);
    return chat;
  }

  async listImportableSessions(workspaceId: string) {
    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return this.session.listImportableSessions(workspaceId);
  }

  async importExistingSession(options: ImportExistingSessionOptions): Promise<Chat> {
    const workspace = await this.state.getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }

    const discoveryDirectory = options.cwd ?? workspace.directory;
    const discoveryBackend = await this.session.getWorkspaceBackend(options.workspaceId, discoveryDirectory);
    const listedSession = (await discoveryBackend.listSessions(options.cwd))
      .find((session) => session.id === options.sessionId);
    const importDirectory = options.cwd ?? listedSession?.cwd ?? workspace.directory;
    const importedName = options.name?.trim() || listedSession?.title?.trim() || "";

    const chat = await this.createChat({
      name: importedName || undefined,
      workspaceId: options.workspaceId,
      modelProviderID: options.modelProviderID,
      modelID: listedSession?.model ?? options.modelID,
      modelVariant: options.modelVariant,
      useWorktree: false,
      autoApprovePermissions: options.autoApprovePermissions,
      directory: importDirectory,
      syncBaseBranch: false,
      prepareWorktreeOnCreate: false,
    });

    const backend = await this.session.ensureBackendConnected(chat);
    let imported: Awaited<ReturnType<Backend["importSession"]>>;
    try {
      imported = await backend.importSession({
        sessionId: options.sessionId,
        cwd: importDirectory,
      });
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        this.state.deletePersistedChat(chat.config.id),
        this.session.disconnectChat(chat.config.id),
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          log.error("Failed to clean up chat after session import failure", {
            chatId: chat.config.id,
            error: String(result.reason),
          });
        }
      }
      throw error;
    }

    const importedState = this.conversation.buildImportedReplayState(chat, imported.events, imported.session.id);
    const updatedChat = await this.state.updateState(chat, importedState);
    this.state.emitChatUpdated(updatedChat);
    return updatedChat;
  }

  async getOrCreateTaskChat(taskId: string, task?: Task): Promise<{ chat: Chat; created: boolean }> {
    const existing = await this.state.getTaskChat(taskId);
    if (existing) {
      return { chat: existing, created: false };
    }

    const targetTask = task ?? await this.taskManager.getTask(taskId);
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
      if (isUniqueConstraint(error, "chats", "task_id")) {
        const concurrent = await this.state.getTaskChat(taskId);
        if (concurrent) {
          return { chat: concurrent, created: false };
        }
      }
      throw error;
    }
  }

  async deleteTaskChat(taskId: string): Promise<boolean> {
    const chat = await this.state.getTaskChat(taskId);
    if (!chat) {
      return false;
    }
    return this.deleteChat(chat.config.id);
  }

  async updateChatStatus(chatId: string, status: ChatStatus): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
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

    return this.state.updateState(chat, state);
  }

  async markChatDone(chatId: string): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }
    if (!isStandaloneChat(chat)) {
      throw new ChatNotMarkableError();
    }
    if (isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting") {
      throw new ChatBusyError();
    }
    if (chat.state.status === "done") {
      return chat;
    }

    const now = createTimestamp();
    return this.state.updateState(
      chat,
      {
        ...chat.state,
        status: "done",
        completedAt: chat.state.completedAt ?? now,
        activeMessageId: undefined,
        interruptRequested: false,
        lastActivityAt: now,
      },
      { expectedStatus: chat.state.status },
    );
  }

  async attachSession(chatId: string, session: SessionInfo): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const now = createTimestamp();
    return this.state.updateState(chat, {
      ...chat.state,
      session,
      startedAt: chat.state.startedAt ?? now,
      lastActivityAt: now,
    });
  }

  async updateChat(chatId: string, updates: ChatConfigUpdates): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }
    if (isWorkspaceChat(chat)) {
      const workspace = await this.state.getWorkspace(getChatWorkspaceId(chat));
      if (!workspace) {
        throw new Error(`Workspace not found: ${getChatWorkspaceId(chat)}`);
      }
      if (
        !isGitBackedWorkspace(workspace)
        && (updates.useWorktree === true || updates.baseBranch !== undefined)
      ) {
        assertGitBackedWorkspace(
          workspace,
          "Directory workspaces do not support branches or worktrees.",
        );
      }
    } else if (updates.useWorktree === true || updates.baseBranch !== undefined) {
      throw new Error("Direct execution-host chats do not support branches or worktrees");
    }

    const config: ChatConfig = {
      ...chat.config,
      ...updates,
      model: updates.model ? { ...chat.config.model, ...updates.model } : chat.config.model,
      updatedAt: createTimestamp(),
    };

    let updatedChat = await this.state.updateConfig(chatId, config);
    if (!updatedChat) {
      return null;
    }

    if (updates.model && updatedChat.state.session?.id) {
      try {
        const backend = await this.session.ensureBackendConnected(updatedChat);
        await this.session.configureSessionModel(backend, updatedChat.state.session.id, updatedChat.config.model.modelID);
        updatedChat = await this.state.getChat(chatId) ?? updatedChat;
      } catch (error) {
        log.warn("Failed to reconfigure active chat session after model update", {
          chatId,
          model: updatedChat.config.model.modelID,
          error: String(error),
        });
      }
    }

    this.state.emitChatUpdated(updatedChat, updatedChat.config.updatedAt);
    return updatedChat;
  }

  async deleteChat(chatId: string, options: DeleteChatOptions = {}): Promise<boolean> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return false;
    }

    if (options.deferCleanup) {
      const user = requireCurrentUser();
      this.conversation.closeActiveStream(chatId);
      const deleted = await this.state.deletePersistedChat(chatId);
      if (!deleted) {
        return false;
      }

      this.state.emitChatDeleted(chat, createTimestamp());
      this.scheduleDeferredChatCleanup(chat, user);
      return true;
    }

    await this.cleanupChatRuntime(chat, {
      closeStream: () => this.conversation.closeActiveStream(chatId),
    });

    const deleted = await this.state.deletePersistedChat(chatId);
    if (deleted) {
      this.state.emitChatDeleted(chat, createTimestamp());
    }
    return deleted;
  }

  private async cleanupChatRuntime(
    chat: Chat,
    options: { continueOnError?: boolean; closeStream?: () => void } = {},
  ): Promise<void> {
    const cleanupSteps: Array<{ label: string; run: () => Promise<void> }> = [];
    if (chat.config.scope !== "task" && isWorkspaceChat(chat)) {
      cleanupSteps.push({
        label: "managed credentials",
        run: async () => {
          const identity = await managedContextIdentityResolver.forChat(
            chat.config.id,
            getChatWorkspaceId(chat),
          );
          await managedCredentialService.revokeContextIfConfigured(identity);
        },
      });
    }
    if (options.closeStream) {
      cleanupSteps.push({
        label: "active chat stream",
        run: async () => {
          options.closeStream?.();
        },
      });
    }
    cleanupSteps.push(
      {
        label: "chat session",
        run: () => this.session.disconnectChat(chat.config.id),
      },
      {
        label: "chat worktree",
        run: () => this.worktree.cleanupWorktree(chat),
      },
    );

    for (const step of cleanupSteps) {
      if (options.continueOnError !== true) {
        await step.run();
        continue;
      }

      try {
        await step.run();
      } catch (error) {
        log.error("Deferred chat cleanup step failed", {
          chatId: chat.config.id,
          step: step.label,
          error: String(error),
        });
      }
    }
  }

  private scheduleDeferredChatCleanup(chat: Chat, user: CurrentUser): void {
    // The persisted chat is already deleted; remote cleanup must not delay the HTTP response.
    void runWithCurrentUser(user, async () => {
      await this.cleanupChatRuntime(chat, { continueOnError: true });
    }).catch((error) => {
      log.error("Deferred chat cleanup failed", {
        chatId: chat.config.id,
        error: String(error),
      });
    });
  }
}
