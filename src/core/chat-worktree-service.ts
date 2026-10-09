/**
 * Workspace-host directory, branch, and managed worktree lifecycle.
 */

import type { Chat, ChatWorktreeState } from "@/shared";
import { ChatBranchCheckoutError, getChatWorkspaceId, InvalidChatBaseBranchError, isTaskChat } from "@/shared/chat";
import { getTaskWorkingDirectory } from "./task/task-types";
import { taskManager, type TaskManager } from "./task-manager";
import { backendManager } from "./backend";
import { GitService, InvalidBranchNameError } from "./git";
import { syncMainCheckoutBeforeWorktree } from "./git/worktree-sync";
import { assertWorktreesAllowed } from "./workspace-capabilities";
import { normalizeExecutionPath } from "./execution-path";
import { sanitizeBranchName } from "../utils";
import { ChatWorktreeBranchConflictError } from "../domain/chat-worktree-errors";
import { createLogger } from "@pablozaiden/webapp/server";
import { createTimestamp } from "@/shared/events";
import type {
  ChatDirectoryResolution,
  ChatStatePort,
  ChatWorktreePort,
} from "./chat-service-contracts";

const log = createLogger("chat-worktree-service");

export interface ChatWorktreeServiceDependencies {
  state: ChatStatePort;
  taskManager?: Pick<TaskManager, "getTask">;
  executorProvider?: Pick<typeof backendManager, "getCommandExecutorAsync">;
}

export class ChatWorktreeService implements ChatWorktreePort {
  private readonly pendingWorktreePreparations = new Map<string, Promise<Chat>>();
  private readonly pendingWorktreeBranchReservations = new Set<string>();
  private readonly state: ChatStatePort;
  private readonly taskManager: Pick<TaskManager, "getTask">;
  private readonly executorProvider: Pick<typeof backendManager, "getCommandExecutorAsync">;

  constructor(dependencies: ChatWorktreeServiceDependencies) {
    this.state = dependencies.state;
    this.taskManager = dependencies.taskManager ?? taskManager;
    this.executorProvider = dependencies.executorProvider ?? backendManager;
  }

  hasEstablishedWorkspaceContext(chat: Chat): boolean {
    return Boolean(chat.config.useWorktree && chat.state.worktree?.worktreePath)
      || Boolean(chat.state.session?.id || chat.state.startedAt);
  }

  async reserveWorktreeBranchForCreation(chat: Chat): Promise<() => void> {
    if (!chat.config.useWorktree || !chat.config.useChatNameAsBranch) {
      return () => {};
    }

    const workspaceId = getChatWorkspaceId(chat);
    const executor = await this.executorProvider.getCommandExecutorAsync(
      workspaceId,
      chat.config.directory,
    );
    const git = GitService.withExecutor(executor);
    const commonGitDirectory = await git.getCommonGitDirectory(chat.config.directory);
    const repositoryKey = normalizeWorktreeRepositoryKey(commonGitDirectory, executor.pathStyle);
    const branchName = this.buildWorkingBranchName(chat);
    const executionTargetKey = chat.config.executionHostBinding?.targetKey ?? workspaceId;
    const reservationKey = JSON.stringify([executionTargetKey, repositoryKey, branchName]);

    if (this.pendingWorktreeBranchReservations.has(reservationKey)) {
      throw new ChatWorktreeBranchConflictError(branchName);
    }
    this.pendingWorktreeBranchReservations.add(reservationKey);

    try {
      const [worktrees, chats] = await Promise.all([
        git.listWorktrees(chat.config.directory),
        this.state.getChatSummaries(),
      ]);
      if (worktrees.some((worktree) => worktree.branch === branchName)) {
        throw new ChatWorktreeBranchConflictError(branchName);
      }

      for (const existingChat of chats) {
        if (
          !existingChat.config.useWorktree
          || this.buildWorkingBranchName(existingChat) !== branchName
        ) {
          continue;
        }
        const existingWorkspaceId = getChatWorkspaceId(existingChat);
        const existingTargetKey = existingChat.config.executionHostBinding?.targetKey;
        if (
          existingTargetKey !== undefined
          && chat.config.executionHostBinding?.targetKey !== undefined
          && existingTargetKey !== chat.config.executionHostBinding.targetKey
        ) {
          continue;
        }
        if (
          (existingTargetKey === undefined || chat.config.executionHostBinding?.targetKey === undefined)
          && existingWorkspaceId !== workspaceId
        ) {
          continue;
        }

        let existingRepositoryKey: string;
        if (existingChat.config.directory === chat.config.directory) {
          existingRepositoryKey = repositoryKey;
        } else {
          const existingExecutor = await this.executorProvider.getCommandExecutorAsync(
            existingWorkspaceId,
            existingChat.config.directory,
          );
          const existingGit = GitService.withExecutor(existingExecutor);
          existingRepositoryKey = normalizeWorktreeRepositoryKey(
            await existingGit.getCommonGitDirectory(existingChat.config.directory),
            existingExecutor.pathStyle,
          );
        }
        if (existingRepositoryKey === repositoryKey) {
          throw new ChatWorktreeBranchConflictError(branchName);
        }
      }

      return () => {
        this.pendingWorktreeBranchReservations.delete(reservationKey);
      };
    } catch (error) {
      this.pendingWorktreeBranchReservations.delete(reservationKey);
      throw error;
    }
  }

  async resolveWorkingDirectory(
    chat: Chat,
    options: { prepareWorkspace: boolean; signal?: AbortSignal },
  ): Promise<ChatDirectoryResolution> {
    throwIfAborted(options.signal);
    if (isTaskChat(chat)) {
      const taskId = chat.config.taskId;
      if (!taskId) {
        throw new Error(`Task chat ${chat.config.id} is missing its taskId`);
      }
      const task = await this.taskManager.getTask(taskId);
      throwIfAborted(options.signal);
      if (!task) {
        throw new Error(`Task ${taskId} for chat ${chat.config.id} was not found`);
      }
      const directory = getTaskWorkingDirectory(task);
      if (!directory) {
        throw new Error(`Task ${taskId} does not currently have a working directory for chat ${chat.config.id}`);
      }
      if (chat.config.workspaceId !== task.config.workspaceId) {
        throw new Error(
          `Task chat ${chat.config.id} belongs to workspace ${chat.config.workspaceId}, but task ${task.config.id} belongs to workspace ${task.config.workspaceId}`,
        );
      }
      if (task.config.useWorktree) {
        const executor = await this.executorProvider.getCommandExecutorAsync(
          task.config.workspaceId,
          task.config.directory,
        );
        const git = GitService.withExecutor(executor);
        return {
          chat,
          directory: await git.assertCanonicalManagedWorktreePath(task.config.directory, task.config.id, directory),
        };
      }
      return { chat, directory };
    }

    if (!chat.config.useWorktree) {
      if (options.prepareWorkspace) {
        await this.ensureStandaloneChatBranch(chat, options.signal);
      }
      throwIfAborted(options.signal);
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
      const executor = await this.executorProvider.getCommandExecutorAsync(getChatWorkspaceId(chat), chat.config.directory);
      throwIfAborted(options.signal);
      const git = GitService.withExecutor(executor);
      return {
        chat,
        directory: await git.assertCanonicalManagedWorktreePath(chat.config.directory, chat.config.id, worktreePath),
      };
    }

    const prepared = await this.ensureWorktree(chat, { signal: options.signal });
    throwIfAborted(options.signal);
    const worktreePath = prepared.state.worktree?.worktreePath;
    if (!worktreePath) {
      throw new Error(`Chat ${chat.config.id} is configured to use a worktree but no worktree path was recorded`);
    }

    return {
      chat: prepared,
      directory: worktreePath,
    };
  }

  async prepareWorktreeState(
    chat: Chat,
    options: { syncBaseBranch?: boolean; signal?: AbortSignal } = {},
  ): Promise<ChatWorktreeState> {
    throwIfAborted(options.signal);
    const executor = await this.executorProvider.getCommandExecutorAsync(getChatWorkspaceId(chat), chat.config.directory);
    throwIfAborted(options.signal);
    const git = GitService.withExecutor(executor);
    const originalBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getCurrentBranch(chat.config.directory);
    throwIfAborted(options.signal);
    const workingBranch = chat.state.worktree?.workingBranch
      ?? this.buildWorkingBranchName(chat);
    const persistedWorktreePath = chat.state.worktree?.worktreePath;
    const worktreePath = persistedWorktreePath
      ? await git.assertCanonicalManagedWorktreePath(chat.config.directory, chat.config.id, persistedWorktreePath)
      : await git.getManagedWorktreePath(chat.config.directory, chat.config.id);

    const worktreeExists = await git.worktreeExists(chat.config.directory, worktreePath);
    throwIfAborted(options.signal);
    if (!worktreeExists) {
      const workspace = await this.state.getWorkspace(getChatWorkspaceId(chat));
      if (!workspace) {
        throw new Error(`Workspace not found: ${getChatWorkspaceId(chat)}`);
      }
      assertWorktreesAllowed(workspace);
      if (options.syncBaseBranch ?? true) {
        await syncMainCheckoutBeforeWorktree({
          git,
          directory: chat.config.directory,
          baseBranch: originalBranch,
          onInfo: (message: string) => {
            log.info(message);
          },
          onDebug: (message: string) => {
            log.debug(message);
          },
        });
      }
      throwIfAborted(options.signal);

      const branchExists = await git.branchExists(chat.config.directory, workingBranch);
      throwIfAborted(options.signal);
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

  async ensureWorktree(chat: Chat, options: { signal?: AbortSignal } = {}): Promise<Chat> {
    if (isTaskChat(chat) || !chat.config.useWorktree) {
      return chat;
    }

    const pendingPreparation = this.pendingWorktreePreparations.get(chat.config.id);
    if (pendingPreparation) {
      return await raceWithAbort(pendingPreparation, options.signal);
    }

    return await raceWithAbort(this.prepareAndPersistWorktree(chat, options.signal), options.signal);
  }

  prepareWorktreeInBackground(chat: Chat): void {
    // Worktree preparation is intentionally detached from chat creation, but
    // owns its error state so a rejected promise cannot become silent.
    void this.prepareAndPersistWorktree(chat).catch(async (error) => {
      try {
        await this.persistPreparationFailure(chat, error);
      } catch (failureError) {
        log.error("Failed to persist deferred chat worktree preparation failure", {
          chatId: chat.config.id,
          error: String(failureError),
        });
      }
    });
  }

  async cleanupWorktree(chat: Chat): Promise<void> {
    if (isTaskChat(chat)) {
      return;
    }

    const worktreePath = chat.state.worktree?.worktreePath;
    if (!chat.config.useWorktree || !worktreePath) {
      return;
    }

    const executor = await this.executorProvider.getCommandExecutorAsync(getChatWorkspaceId(chat), chat.config.directory);
    const git = GitService.withExecutor(executor);
    const managedWorktreePath = await git.assertCanonicalManagedWorktreePath(
      chat.config.directory,
      chat.config.id,
      worktreePath,
    );
    await git.ensureWorktreeRemoved(chat.config.directory, managedWorktreePath, {
      force: true,
    });
  }

  private prepareAndPersistWorktree(chat: Chat, signal?: AbortSignal): Promise<Chat> {
    const existing = this.pendingWorktreePreparations.get(chat.config.id);
    if (existing) {
      return existing;
    }

    const preparation = this.doPrepareAndPersistWorktree(chat, signal).finally(() => {
      if (this.pendingWorktreePreparations.get(chat.config.id) === preparation) {
        this.pendingWorktreePreparations.delete(chat.config.id);
      }
    });
    this.pendingWorktreePreparations.set(chat.config.id, preparation);
    return preparation;
  }

  private async doPrepareAndPersistWorktree(chat: Chat, signal?: AbortSignal): Promise<Chat> {
    const nextWorktreeState = await this.prepareWorktreeState(chat, {
      syncBaseBranch: !chat.config.skipBaseBranchSync,
      signal,
    });
    throwIfAborted(signal);
    const latest = await this.state.getChat(chat.config.id) ?? chat;
    throwIfAborted(signal);
    const worktreeChanged =
      latest.state.worktree?.originalBranch !== nextWorktreeState.originalBranch
      || latest.state.worktree?.workingBranch !== nextWorktreeState.workingBranch
      || latest.state.worktree?.worktreePath !== nextWorktreeState.worktreePath;
    const shouldClearCreationStage =
      latest.state.status === "idle"
      && latest.state.messages.length === 0
      && latest.state.startupStage === "preparing_workspace";
    if (!worktreeChanged && !shouldClearCreationStage) {
      return latest;
    }

    const updated = await this.state.updateState(latest, {
      ...latest.state,
      worktree: nextWorktreeState,
      ...(shouldClearCreationStage ? { startupStage: undefined } : {}),
      lastActivityAt: latest.state.lastActivityAt ?? createTimestamp(),
    }, {
      expectedStatus: latest.state.status,
    });
    this.state.emitChatUpdated(updated);
    return updated;
  }

  private async persistPreparationFailure(chat: Chat, error: unknown): Promise<void> {
    const latest = await this.state.getChat(chat.config.id);
    if (!latest) {
      log.warn("Deferred chat worktree preparation failed after chat deletion", {
        chatId: chat.config.id,
        error: String(error),
      });
      return;
    }

    log.error("Deferred chat worktree preparation failed", {
      chatId: chat.config.id,
      error: String(error),
    });
    await this.state.markChatError(latest, `Failed to prepare chat workspace: ${String(error)}`);
  }

  private async ensureStandaloneChatBranch(chat: Chat, signal?: AbortSignal): Promise<void> {
    if (isTaskChat(chat) || chat.config.useWorktree) {
      return;
    }

    const expectedBranch = chat.config.baseBranch?.trim();
    if (!expectedBranch) {
      return;
    }

    const executor = await this.executorProvider.getCommandExecutorAsync(getChatWorkspaceId(chat), chat.config.directory);
    throwIfAborted(signal);
    const git = GitService.withExecutor(executor);
    const isGitRepo = await git.isGitRepo(chat.config.directory);
    throwIfAborted(signal);
    if (!isGitRepo) {
      return;
    }

    try {
      await git.assertValidBranchName(chat.config.directory, expectedBranch);
      throwIfAborted(signal);
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
      throwIfAborted(signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new ChatBranchCheckoutError(
        expectedBranch,
        `Unable to switch the standalone chat to branch '${expectedBranch}'. ${String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (result.checkedOut) {
      log.info("Checked out selected branch for standalone chat", {
        chatId: chat.config.id,
        fromBranch: result.currentBranch,
        toBranch: result.expectedBranch,
      });
    }

  }

  private buildWorkingBranchName(chat: Chat): string {
    if (chat.config.useChatNameAsBranch) {
      return sanitizeBranchName(chat.config.name);
    }
    return `chat-${sanitizeBranchName(chat.config.name)}-${chat.config.id.slice(0, 8)}`;
  }
}

function normalizeWorktreeRepositoryKey(
  repositoryRoot: string,
  pathStyle: "posix" | "windows",
): string {
  const normalized = normalizeExecutionPath(repositoryRoot, pathStyle);
  return pathStyle === "windows" ? normalized.toLowerCase() : normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Chat startup was aborted.");
  }
}

async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await operation;
  }
  throwIfAborted(signal);
  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error("Chat startup was aborted."),
    );
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
