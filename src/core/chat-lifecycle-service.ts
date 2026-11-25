/**
 * Chat creation, configuration, and deletion workflows.
 */

import type { Chat, ChatConfig, ChatStatus, SessionInfo } from "@/shared";
import {
  DEFAULT_CHAT_CONFIG,
  createInitialChatState,
  ChatBusyError,
  ChatNotMarkableError,
  getCurrentChatDirectory,
  isChatBusyStatus,
  isStandaloneChat,
  getChatWorkspaceId,
  isWorkspaceChat,
  hasRemoteChatContinuity,
} from "@/shared/chat";
import { createTimestamp } from "@/shared/events";
import { createLogger } from "@pablozaiden/webapp/server";
import { logHarnessFailure } from "../backends/harness-diagnostics";
import { buildGeneratedChatName } from "./chat-name";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { managedCredentialService } from "./managed-credential-service";
import { createChatLatencyTimer } from "./chat-latency-instrumentation";
import {
  assertGitBackedWorkspace,
  assertWorktreesAllowed,
  isGitBackedWorkspace,
} from "./workspace-capabilities";
import type {
  ChatConfigUpdates,
  ChatConversationPort,
  DeleteChatOptions,
  ChatLifecyclePort,
  ChatSessionPort,
  ChatStatePort,
  ChatWorktreePort,
  CreateAutomationRunChatOptions,
  CreateChatOptions,
  CreateExecutionHostChatOptions,
} from "./chat-service-contracts";
import type { CurrentUser } from "@/platform/contracts";
import { requireExecutionOwnerUser, runWithExecutionOwner } from "../context/user-context";
import { executionHostService } from "./execution-host-service";
import { closeCommandExecutor } from "./command-executor";
import { planRepositoryGroup } from "./repository-group-service";
import {
  EXECUTION_HOST_CAPABILITY_VERSIONS,
  executionHostBindingsEqual,
  getAgentExecutionHostCapability,
} from "@/shared/execution-host";
import { DomainError } from "../domain/domain-error";
import { hasRepositoryGroupDependents } from "../persistence/chats/trash";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import type { ChatHistoryExportService } from "./chat-history-export-service";
import { conversationAttachmentService } from "./conversation-attachment-service";
import { resourcePrivacyEventEmitter } from "./event-emitter";

const log = createLogger("chat-lifecycle-service");

export interface ChatLifecycleServiceDependencies {
  state: ChatStatePort;
  worktree: ChatWorktreePort;
  session: ChatSessionPort;
  conversation: ChatConversationPort;
  historyExport: Pick<ChatHistoryExportService, "cleanup">;
}

export class ChatLifecycleService implements ChatLifecyclePort {
  private readonly repositoryGroupOperations = new KeyedOperationQueue();
  private readonly state: ChatStatePort;
  private readonly worktree: ChatWorktreePort;
  private readonly session: ChatSessionPort;
  private readonly conversation: ChatConversationPort;
  private readonly historyExport?: Pick<ChatHistoryExportService, "cleanup">;

  constructor(dependencies: Partial<ChatLifecycleServiceDependencies> & Pick<
    ChatLifecycleServiceDependencies,
    "state" | "worktree" | "session" | "conversation"
  >) {
    this.state = dependencies.state;
    this.worktree = dependencies.worktree;
    this.session = dependencies.session;
    this.conversation = dependencies.conversation;
    this.historyExport = dependencies.historyExport;
  }

  async createChat(options: CreateChatOptions): Promise<Chat> {
    const timer = createChatLatencyTimer();
    const workspace = await timer.measure("workspace_lookup", () => this.state.getWorkspace(options.workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${options.workspaceId}`);
    }
    if (
      options.expectedExecutionHostBinding
      && !executionHostBindingsEqual(
        options.expectedExecutionHostBinding,
        workspace.executionHostBinding,
      )
    ) {
      throw new DomainError(
        "execution_host_binding_stale",
        "The workspace execution host changed while creating the chat.",
      );
    }
    executionHostService.requireBindingCapability(
      workspace.executionHostBinding,
      getAgentExecutionHostCapability(workspace.serverSettings.agent.adapter),
      undefined,
      1,
    );
    const scope = options.scope ?? DEFAULT_CHAT_CONFIG.scope;
    const multiGit = workspace.workspaceType === "multi-git";
    const groupExecution = multiGit && !options.sharedGroup
      && !(scope === "automation" && options.useWorktree === false && options.prepareWorktreeOnCreate === false);
    if (multiGit && (options.baseBranch !== undefined || options.useSelectedBranchForWorktree || options.useChatNameAsBranch)) {
      throw new DomainError("repository_group_unavailable", "Choose a base per repository. Multirepository chats use new working branches.");
    }
    if (groupExecution && ((options.directory !== undefined && options.directory !== workspace.directory) || options.useWorktree === false)) {
      throw new DomainError("repository_group_unavailable", "Multirepository chats use an isolated group at the workspace directory.");
    }
    if (!multiGit && options.repositoryBases !== undefined) {
      throw new DomainError("repository_group_unavailable", "Per-repository bases require a multirepository workspace.");
    }
    if (options.directory !== undefined) {
      await executionHostService.assertDirectoryExists(
        workspace.executionHostBinding,
        options.directory,
      );
    }

    if (
      !multiGit && !isGitBackedWorkspace(workspace)
      && (
        options.useWorktree === true
        || options.useSelectedBranchForWorktree === true
        || options.baseBranch !== undefined
      )
    ) {
      assertGitBackedWorkspace(
        workspace,
        "Directory workspaces do not support branches or worktrees.",
      );
    }
    const useWorktree = groupExecution || (isGitBackedWorkspace(workspace)
      ? (options.useWorktree ?? DEFAULT_CHAT_CONFIG.useWorktree)
      : false);
    if (useWorktree) {
      assertWorktreesAllowed(workspace);
    }
    if (
      options.useSelectedBranchForWorktree === true
      && (
        scope !== "workspace"
        || !useWorktree
        || !options.baseBranch?.trim()
        || options.useChatNameAsBranch
      )
    ) {
      throw new Error(
        "Using the selected branch in a worktree requires a workspace chat, an enabled worktree, a selected branch, and no chat-name branch.",
      );
    }
    if (options.useSelectedBranchForWorktree === true) {
      executionHostService.requireBindingCapability(
        workspace.executionHostBinding,
        "managedWorktrees",
        undefined,
        EXECUTION_HOST_CAPABILITY_VERSIONS.managedWorktrees,
      );
    }

    const id = crypto.randomUUID();
    const state = createInitialChatState(id);
    if (options.sharedGroup) {
      state.worktree = options.sharedGroup;
    } else if (groupExecution) {
      const executor = await executionHostService.getCommandExecutor(workspace.executionHostBinding, {
        directory: workspace.directory,
        operationId: `chat-group:${id}`,
        sshKeyTarget: { kind: "workspace", id: workspace.id },
        provider: workspace.serverSettings.agent.provider,
        localUserId: requireExecutionOwnerUser().id,
      });
      try {
        state.worktree = {
          group: await timer.measure("worktree_preparation", () => planRepositoryGroup(
            executor, workspace.directory, id, {
              bases: options.repositoryBases,
              defaults: workspace.repositoryBases,
              refresh: options.syncBaseBranch !== false,
            },
          )),
        };
      } finally {
        closeCommandExecutor(executor);
      }
    }
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
        directory: options.directory ?? workspace.directory,
        model: {
          providerID: options.modelProviderID,
          modelID: options.modelID,
          variant: options.modelVariant ?? "",
        },
        useWorktree,
        startWithPlan: options.startWithPlan === true,
        useSelectedBranchForWorktree:
          useWorktree && options.useSelectedBranchForWorktree === true,
        ...(useWorktree && options.useChatNameAsBranch ? { useChatNameAsBranch: true } : {}),
        autoApprovePermissions: true,
        skipBaseBranchSync: options.syncBaseBranch === false,
        baseBranch: isGitBackedWorkspace(workspace) ? options.baseBranch : undefined,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state,
    };

    const shouldPrepareWorktreeOnCreate =
      chat.config.useWorktree && (options.prepareWorktreeOnCreate ?? false);
    const prepareBeforeSave = shouldPrepareWorktreeOnCreate && !groupExecution;
    const initialChat = prepareBeforeSave || !chat.config.useWorktree
      ? chat
      : {
          ...chat,
          state: {
            ...chat.state,
            startupStage: "preparing_workspace" as const,
          },
        };
    await this.worktree.assertWorktreeBranchAvailable(initialChat);
    let preparedChat = prepareBeforeSave
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
    if (groupExecution && shouldPrepareWorktreeOnCreate) {
      try {
        preparedChat = await this.worktree.ensureWorktree(preparedChat);
      } catch (error) {
        try {
          await this.deleteChat(id);
        } catch (cleanupError) {
          options.onRetainedGroup?.(preparedChat);
          const message = `${String(error)} Cleanup remains pending: ${String(cleanupError)}`;
          await this.state.markChatError(preparedChat, message);
          throw new DomainError("repository_group_unavailable", message, { cause: error });
        }
        throw error;
      }
    }
    if (!shouldPrepareWorktreeOnCreate && preparedChat.config.useWorktree) {
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

  async createChatHere(sourceChatId: string): Promise<Chat> {
    const sourceChat = await this.state.getChatSummary(sourceChatId);
    if (!sourceChat) {
      throw new DomainError("chat_not_found", "Chat not found.");
    }
    const group = sourceChat.state.worktree?.group;
    if (!group) return await this.createChatFromSource(sourceChat);
    return await this.repositoryGroupOperations.run(group.ownerChatId, async () => {
      const current = await this.state.getChatSummary(sourceChatId);
      if (!current) throw new DomainError("chat_not_found", "Chat not found.");
      if (current.state.worktree?.group?.ownerChatId !== group.ownerChatId) {
        throw new DomainError("repository_group_unavailable", "The source chat no longer uses this repository group.");
      }
      await this.worktree.resolveWorkingDirectory(current, { prepareWorkspace: false });
      return await this.createChatFromSource(current);
    });
  }

  private async createChatFromSource(sourceChat: Chat): Promise<Chat> {
    if (!isWorkspaceChat(sourceChat)) {
      throw new DomainError(
        "chat_context_unavailable",
        "The source chat does not have a workspace directory.",
      );
    }

    const workspaceId = sourceChat.config.source?.kind === "workspace"
      ? sourceChat.config.source.workspaceId
      : sourceChat.config.workspaceId;
    const sourceBinding = sourceChat.config.executionHostBinding;
    const directory = getCurrentChatDirectory(sourceChat);
    if (!workspaceId || !sourceBinding || !directory) {
      throw new DomainError(
        "chat_context_unavailable",
        "The source chat's workspace directory or execution target is unavailable.",
      );
    }

    const workspace = await this.state.getWorkspace(workspaceId);
    if (!workspace) {
      throw new DomainError(
        "chat_context_unavailable",
        "The source chat's workspace is unavailable.",
      );
    }
    if (!executionHostBindingsEqual(sourceBinding, workspace.executionHostBinding)) {
      throw new DomainError(
        "execution_host_binding_stale",
        "The workspace execution host changed after the source chat was created.",
      );
    }

    return await this.createChat({
      workspaceId,
      expectedExecutionHostBinding: sourceBinding,
      directory,
      sharedGroup: sourceChat.state.worktree?.group ? sourceChat.state.worktree : undefined,
      modelProviderID: sourceChat.config.model.providerID,
      modelID: sourceChat.config.model.modelID,
      modelVariant: sourceChat.config.model.variant,
      useWorktree: false,
      syncBaseBranch: true,
    });
  }

  async createAutomationRunChat(options: CreateAutomationRunChatOptions): Promise<Chat> {
    return this.createChat({
      ...options,
      scope: "automation",
      prepareWorktreeOnCreate: options.prepareWorktreeOnCreate ?? true,
    });
  }

  async createExecutionHostChat(options: CreateExecutionHostChatOptions): Promise<Chat> {
    executionHostService.requireBindingCapability(
      options.executionHost,
      "commandExecution",
      undefined,
      1,
    );
    const id = crypto.randomUUID();
    const now = createTimestamp();
    const chat: Chat = {
      config: {
        id,
        name: options.name?.trim() || `${options.executionHost.targetKey} chat`,
        source: {
          kind: "execution_host",
          adapter: options.adapter,
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
        startWithPlan: options.startWithPlan === true,
        autoApprovePermissions: true,
        createdAt: now,
        updatedAt: now,
        mode: DEFAULT_CHAT_CONFIG.mode,
      },
      state: {
        ...createInitialChatState(id),
        connectionStatus: "disconnected",
      },
    };
    await this.state.saveNewChat(chat);
    this.state.emitChatCreated(chat, now);
    return chat;
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
      state.harness = {
        ...chat.state.harness,
        activeTurnAttachmentBytes: 0,
        providerLimit: undefined,
      };
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
    if (this.conversation.hasActiveStream(chatId) || isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting") {
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
        harness: {
          ...chat.state.harness,
          providerLimit: undefined,
          activeTurnAttachmentBytes: 0,
        },
        lastActivityAt: now,
      },
      { expectedStatus: chat.state.status, statusChangedAt: null },
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
      if (workspace.workspaceType === "multi-git" && (
        updates.baseBranch !== undefined || (updates.useWorktree !== undefined && updates.useWorktree !== chat.config.useWorktree)
      )) {
        throw new DomainError("repository_group_unavailable", "A chat's repository group cannot be changed after creation.");
      }
      if (
        !isGitBackedWorkspace(workspace)
        && workspace.workspaceType !== "multi-git"
        && (updates.useWorktree === true || updates.baseBranch !== undefined)
      ) {
        assertGitBackedWorkspace(
          workspace,
          "Directory workspaces do not support branches or worktrees.",
        );
      }
      if (
        updates.useWorktree === true
        && chat.config.useWorktree !== true
      ) {
        assertWorktreesAllowed(workspace);
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
    if ((updatedChat.config.isPrivate === true) !== (chat.config.isPrivate === true) || updates.source !== undefined) {
      resourcePrivacyEventEmitter.emit({ type: "resource.privacy_changed" });
    }

    if (updates.model && updatedChat.state.session?.id) {
      try {
        const backend = await this.session.ensureBackendConnected(updatedChat);
        await this.session.configureSessionModel(backend, updatedChat.state.session.id, updatedChat.config.model.modelID);
        updatedChat = await this.state.getChat(chatId) ?? updatedChat;
      } catch (error) {
        const diagnostic = logHarnessFailure(error, {
          adapter: updatedChat.state.session?.binding?.adapter, operation: "configure", chatId,
        }, "warn");
        updatedChat = await this.state.mutateState(chatId, (current) => ({
          ...current.state, harness: { ...current.state.harness, lastFailure: diagnostic },
        }));
      }
    }

    this.state.emitChatUpdated(updatedChat, updatedChat.config.updatedAt);
    return updatedChat;
  }

  async deleteChat(chatId: string, options: DeleteChatOptions = {}): Promise<boolean> {
    const snapshot = await this.state.getChatSummary(chatId);
    if (!snapshot) return false;
    const group = snapshot.state.worktree?.group;
    return await this.withPermanentChatRemoval(snapshot, async () => {
      const chat = group ? await this.state.getChatSummary(chatId) : snapshot;
      if (!chat) return false;

      if (hasRemoteChatContinuity(chat)) await this.conversation.interruptChat(chatId);
      if (options.deferCleanup && !group) {
        const result = await this.deleteChatDeferred(chat);
        return result.deleted;
      }
      if (group) await this.worktree.waitForPreparation(chatId);

      const complete = await this.cleanupChatRuntime(chat, {
        closeStream: () => this.conversation.closeActiveStream(chatId),
      });
      if (!complete && group) {
        throw new DomainError("repository_group_unavailable", "The chat was kept because its repository group could not be safely cleaned up.");
      }
      const deleted = await this.state.deletePersistedChat(chatId);
      if (deleted) this.state.emitChatDeleted(chat, createTimestamp());
      return deleted;
    });
  }

  async withPermanentChatRemoval<T>(chat: Chat, remove: () => Promise<T>): Promise<T> {
    const group = chat.state.worktree?.group;
    if (!group) return await remove();
    return await this.repositoryGroupOperations.run(group.ownerChatId, async () => {
      const { id, workspaceId } = chat.config;
      if (id === group.ownerChatId && workspaceId && hasRepositoryGroupDependents(id, workspaceId)) {
        throw new DomainError("repository_group_in_use", "Other chats share this directory. Permanently delete them before deleting this chat.");
      }
      return await remove();
    });
  }

  private async cleanupChatRuntime(
    chat: Chat,
    options: {
      continueOnError?: boolean;
      closeStream?: () => void;
      preserveWorktree?: boolean;
    } = {},
  ): Promise<boolean> {
    let succeeded = true;
    const cleanupSteps: Array<{ label: string; run: () => Promise<void | boolean>; requiresRuntimeCleanup?: boolean }> = [];
    const historyRecovery = chat.state.harness?.historyRecovery;
    const historyExports = new Map(
      (chat.state.harness?.historyRecoveryCleanup ?? []).map((recovery) => [recovery.id, recovery]),
    );
    if (historyRecovery && historyRecovery.status !== "complete") {
      historyExports.set(historyRecovery.id, historyRecovery);
    }
    if (isWorkspaceChat(chat)) {
      cleanupSteps.push({
        label: "managed credentials",
        run: async () => {
          const identity = await managedContextIdentityResolver.forChatSnapshot(
            chat,
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
      ...(!options.preserveWorktree && this.historyExport
        ? Array.from(historyExports.values(), (recovery) => ({
          label: "chat history export",
          requiresRuntimeCleanup: true,
          run: () => this.historyExport!.cleanup(
            chat, recovery, { markComplete: false },
          ),
        })) : []),
      ...(!options.preserveWorktree ? [{
        label: "chat attachments",
        requiresRuntimeCleanup: true,
        run: () => conversationAttachmentService.cleanup({ kind: "chat", id: chat.config.id }),
      }, {
        label: "chat worktree",
        requiresRuntimeCleanup: true,
        run: () => this.worktree.cleanupWorktree(chat),
      }] : []),
    );

    for (const step of cleanupSteps) {
      if (step.requiresRuntimeCleanup && !succeeded) continue;
      if (options.continueOnError !== true) {
        if (await step.run() === false) return false;
        continue;
      }

      try {
        const stepSucceeded = await step.run();
        if (stepSucceeded === false) {
          succeeded = false;
        }
      } catch (error) {
        succeeded = false;
        log.error("Deferred chat cleanup step failed", {
          chatId: chat.config.id,
          step: step.label,
          error: String(error),
        });
      }
    }
    return succeeded;
  }

  async cleanupTrashResources(
    chat: Chat,
    options: { preserveWorktree?: boolean } = {},
  ): Promise<boolean> {
    const [runtime] = await Promise.all([
      this.cleanupChatRuntime(chat, { ...options, continueOnError: true }),
      this.conversation.stopForDeletion(chat.config.id),
    ]);
    await this.worktree.waitForPreparation(chat.config.id);
    return runtime;
  }

  private async deleteChatDeferred(
    chat: Chat,
  ): Promise<{ deleted: boolean; cleanup: Promise<boolean> }> {
    const user = requireExecutionOwnerUser();
    this.conversation.closeActiveStream(chat.config.id);
    const deleted = await this.state.deletePersistedChat(chat.config.id);
    if (!deleted) {
      return { deleted: false, cleanup: Promise.resolve(false) };
    }

    this.state.emitChatDeleted(chat, createTimestamp());
    return {
      deleted: true,
      cleanup: this.scheduleDeferredChatCleanup(chat, user),
    };
  }

  private scheduleDeferredChatCleanup(
    chat: Chat,
    user: CurrentUser,
  ): Promise<boolean> {
    // The persisted chat is already deleted; remote cleanup must not delay the HTTP response.
    return runWithExecutionOwner(user, async () => {
      return await this.cleanupChatRuntime(chat, {
        continueOnError: true,
      });
    }).catch((error) => {
      log.error("Deferred chat cleanup failed", {
        chatId: chat.config.id,
        error: String(error),
      });
      return false;
    });
  }
}
