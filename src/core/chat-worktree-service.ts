/**
 * Workspace-host directory, branch, and managed worktree lifecycle.
 */

import type { Chat, ChatWorktreeState } from "@/shared";
import { ChatBranchCheckoutError, getChatWorkspaceId, InvalidChatBaseBranchError, isTaskChat } from "@/shared/chat";
import { getTaskWorkingDirectory } from "./task/task-types";
import { taskManager, type TaskManager } from "./task-manager";
import { backendManager } from "./backend";
import type { CommandExecutor } from "./command-executor";
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

interface SelectedWorktreeBranch {
  branchName: string;
  remoteRef?: string;
}

export class ChatWorktreeService implements ChatWorktreePort {
  private readonly pendingWorktreePreparations = new Map<string, Promise<Chat>>();
  private readonly pendingWorktreeBranchReservations = new Set<string>();
  private readonly pendingSelectedWorktreeBranchLocks = new Map<string, Promise<void>>();
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
    const selectedBranch = chat.config.useSelectedBranchForWorktree
      ? await this.resolveSelectedWorktreeBranch(chat, git)
      : undefined;
    const originalBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getCurrentBranch(chat.config.directory);
    throwIfAborted(options.signal);
    const workingBranch = chat.state.worktree?.workingBranch
      ?? selectedBranch?.branchName
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
      if (!chat.config.useSelectedBranchForWorktree && (options.syncBaseBranch ?? true)) {
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

      if (chat.config.useSelectedBranchForWorktree) {
        await this.addSelectedBranchWorktree(
          executor,
          git,
          chat,
          worktreePath,
          selectedBranch ?? { branchName: workingBranch },
        );
      } else {
        const branchExists = await git.branchExists(chat.config.directory, workingBranch);
        throwIfAborted(options.signal);
        if (branchExists) {
          await git.addWorktreeForExistingBranch(chat.config.directory, worktreePath, workingBranch);
        } else {
          await git.createWorktree(chat.config.directory, worktreePath, workingBranch, originalBranch);
        }
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

    let currentBranch: string;
    let selectedBranch: string;
    try {
      const remoteBase = await git.parseRemoteBranchReference(
        chat.config.directory,
        expectedBranch,
      );
      currentBranch = await git.getCurrentBranch(chat.config.directory);
      if (remoteBase) {
        selectedBranch = await git.checkoutRemoteBranch(
          chat.config.directory,
          remoteBase.branch,
          remoteBase.ref,
        );
      } else {
        const result = await git.ensureBranch(chat.config.directory, expectedBranch, {
          autoCheckout: true,
        });
        currentBranch = result.currentBranch;
        selectedBranch = result.expectedBranch;
        if (!result.checkedOut) {
          return;
        }
      }
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

    if (currentBranch !== selectedBranch) {
      log.info("Checked out selected branch for standalone chat", {
        chatId: chat.config.id,
        fromBranch: currentBranch,
        toBranch: selectedBranch,
      });
    }
  }

  private buildWorkingBranchName(chat: Chat): string {
    if (chat.config.useChatNameAsBranch) {
      return sanitizeBranchName(chat.config.name);
    }
    return `chat-${sanitizeBranchName(chat.config.name)}-${chat.config.id.slice(0, 8)}`;
  }

  private async resolveSelectedWorktreeBranch(
    chat: Chat,
    git: GitService,
  ): Promise<SelectedWorktreeBranch> {
    const persistedBranch = chat.state.worktree?.workingBranch;
    if (persistedBranch) {
      await git.assertValidBranchName(chat.config.directory, persistedBranch);
      const persistedBaseBranch = chat.config.baseBranch?.trim();
      if (persistedBaseBranch) {
        const remoteBranch = await git.parseRemoteBranchReference(
          chat.config.directory,
          persistedBaseBranch,
        );
        if (remoteBranch?.branch === persistedBranch) {
          return {
            branchName: persistedBranch,
            remoteRef: remoteBranch.ref,
          };
        }
      }
      return { branchName: persistedBranch };
    }

    const selectedBranch = chat.config.baseBranch?.trim();
    if (!selectedBranch) {
      throw new Error(
        `Chat ${chat.config.id} is configured to use the selected worktree branch but has no selected branch.`,
      );
    }

    const remoteBranch = await git.parseRemoteBranchReference(
      chat.config.directory,
      selectedBranch,
    );
    const branchName = remoteBranch?.branch ?? selectedBranch;
    await git.assertValidBranchName(chat.config.directory, branchName);
    return {
      branchName,
      ...(remoteBranch ? { remoteRef: remoteBranch.ref } : {}),
    };
  }

  private async addSelectedBranchWorktree(
    executor: CommandExecutor,
    git: GitService,
    chat: Chat,
    worktreePath: string,
    selectedBranch: SelectedWorktreeBranch,
  ): Promise<void> {
    const workspaceId = getChatWorkspaceId(chat);
    const commonGitDirectory = await git.getCommonGitDirectory(chat.config.directory);
    const repositoryKey = normalizeWorktreeRepositoryKey(commonGitDirectory, executor.pathStyle);
    const executionTargetKey = chat.config.executionHostBinding?.targetKey ?? workspaceId;
    const lockKey = JSON.stringify([
      executionTargetKey,
      repositoryKey,
      selectedBranch.branchName,
    ]);

    await this.withSelectedWorktreeBranchLock(lockKey, async () => {
      const localBranchRef = `refs/heads/${selectedBranch.branchName}`;
      const localBranchExists = await git.branchExists(
        chat.config.directory,
        localBranchRef,
      );

      if (!selectedBranch.remoteRef) {
        if (!localBranchExists) {
          throw new Error(`Selected local branch "${selectedBranch.branchName}" does not exist.`);
        }
        await git.addWorktreeForExistingBranch(
          chat.config.directory,
          worktreePath,
          selectedBranch.branchName,
          { force: true },
        );
        return;
      }

      const remoteBranchExists = await git.branchExists(
        chat.config.directory,
        `refs/remotes/${selectedBranch.remoteRef}`,
      );
      if (!remoteBranchExists) {
        throw new Error(`Selected remote branch "${selectedBranch.remoteRef}" does not exist.`);
      }

      if (localBranchExists) {
        const upstream = await git.getBranchUpstream(
          chat.config.directory,
          selectedBranch.branchName,
        );
        if (upstream !== selectedBranch.remoteRef) {
          throw new Error(
            `Local branch "${selectedBranch.branchName}" does not track selected remote branch "${selectedBranch.remoteRef}".`,
          );
        }
        await git.addWorktreeForExistingBranch(
          chat.config.directory,
          worktreePath,
          selectedBranch.branchName,
          { force: true },
        );
        return;
      }

      try {
        await git.addWorktreeForRemoteBranch(
          chat.config.directory,
          worktreePath,
          selectedBranch.branchName,
          selectedBranch.remoteRef,
        );
      } catch (error) {
        const branchCreatedConcurrently = await git.branchExists(
          chat.config.directory,
          localBranchRef,
        );
        if (!branchCreatedConcurrently) {
          throw error;
        }
        const upstream = await git.getBranchUpstream(
          chat.config.directory,
          selectedBranch.branchName,
        );
        if (upstream !== selectedBranch.remoteRef) {
          throw error;
        }
        await git.addWorktreeForExistingBranch(
          chat.config.directory,
          worktreePath,
          selectedBranch.branchName,
          { force: true },
        );
      }
    });
  }

  private async withSelectedWorktreeBranchLock(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.pendingSelectedWorktreeBranchLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingSelectedWorktreeBranchLocks.set(key, current);
    await previous;
    try {
      await operation();
    } finally {
      release();
      if (this.pendingSelectedWorktreeBranchLocks.get(key) === current) {
        this.pendingSelectedWorktreeBranchLocks.delete(key);
      }
    }
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
