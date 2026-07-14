/**
 * Workspace-host directory, branch, and managed worktree lifecycle.
 */

import type { Chat, ChatWorktreeState } from "@/shared";
import { ChatBranchCheckoutError, InvalidChatBaseBranchError, isTaskChat } from "@/shared/chat";
import { getTaskWorkingDirectory } from "./task/task-types";
import { taskManager, type TaskManager } from "./task-manager";
import { backendManager } from "./backend";
import { GitService, InvalidBranchNameError } from "./git";
import { syncMainCheckoutBeforeWorktree } from "./git/worktree-sync";
import { sanitizeBranchName } from "../utils";
import { createLogger } from "./logger";
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
  private readonly state: ChatStatePort;
  private readonly taskManager: Pick<TaskManager, "getTask">;
  private readonly executorProvider: Pick<typeof backendManager, "getCommandExecutorAsync">;

  constructor(dependencies: ChatWorktreeServiceDependencies) {
    this.state = dependencies.state;
    this.taskManager = dependencies.taskManager ?? taskManager;
    this.executorProvider = dependencies.executorProvider ?? backendManager;
  }

  hasEstablishedWorkspaceContext(chat: Chat): boolean {
    return Boolean(chat.state.session?.id || chat.state.startedAt);
  }

  async resolveWorkingDirectory(
    chat: Chat,
    options: { prepareWorkspace: boolean },
  ): Promise<ChatDirectoryResolution> {
    if (isTaskChat(chat)) {
      const taskId = chat.config.taskId;
      if (!taskId) {
        throw new Error(`Task chat ${chat.config.id} is missing its taskId`);
      }
      const task = await this.taskManager.getTask(taskId);
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
          directory: git.assertCanonicalManagedWorktreePath(task.config.directory, task.config.id, directory),
        };
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
      const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
      const git = GitService.withExecutor(executor);
      return {
        chat,
        directory: git.assertCanonicalManagedWorktreePath(chat.config.directory, chat.config.id, worktreePath),
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

  async prepareWorktreeState(
    chat: Chat,
    options: { syncBaseBranch?: boolean } = {},
  ): Promise<ChatWorktreeState> {
    const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const originalBranch = chat.state.worktree?.originalBranch
      ?? chat.config.baseBranch
      ?? await git.getCurrentBranch(chat.config.directory);
    const workingBranch = chat.state.worktree?.workingBranch
      ?? this.buildWorkingBranchName(chat);
    const persistedWorktreePath = chat.state.worktree?.worktreePath;
    const worktreePath = persistedWorktreePath
      ? git.assertCanonicalManagedWorktreePath(chat.config.directory, chat.config.id, persistedWorktreePath)
      : git.getManagedWorktreePath(chat.config.directory, chat.config.id);

    const worktreeExists = await git.worktreeExists(chat.config.directory, worktreePath);
    if (!worktreeExists) {
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

  async ensureWorktree(chat: Chat): Promise<Chat> {
    if (isTaskChat(chat) || !chat.config.useWorktree) {
      return chat;
    }

    const pendingPreparation = this.pendingWorktreePreparations.get(chat.config.id);
    if (pendingPreparation) {
      return pendingPreparation;
    }

    return this.prepareAndPersistWorktree(chat);
  }

  prepareWorktreeInBackground(chat: Chat): void {
    void this.prepareAndPersistWorktree(chat).catch((error) => {
      log.warn("Deferred chat worktree preparation failed", {
        chatId: chat.config.id,
        error: String(error),
      });
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

    const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
    const git = GitService.withExecutor(executor);
    const managedWorktreePath = git.assertCanonicalManagedWorktreePath(
      chat.config.directory,
      chat.config.id,
      worktreePath,
    );
    await git.ensureWorktreeRemoved(chat.config.directory, managedWorktreePath, {
      force: true,
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

    return this.state.updateState(chat, {
      ...chat.state,
      worktree: nextWorktreeState,
      lastActivityAt: chat.state.lastActivityAt ?? createTimestamp(),
    });
  }

  private async ensureStandaloneChatBranch(chat: Chat): Promise<void> {
    if (isTaskChat(chat) || chat.config.useWorktree) {
      return;
    }

    const expectedBranch = chat.config.baseBranch?.trim();
    if (!expectedBranch) {
      return;
    }

    const executor = await this.executorProvider.getCommandExecutorAsync(chat.config.workspaceId, chat.config.directory);
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
      log.info("Checked out selected branch for standalone chat", {
        chatId: chat.config.id,
        fromBranch: result.currentBranch,
        toBranch: result.expectedBranch,
      });
    }
  }

  private buildWorkingBranchName(chat: Chat): string {
    return `chat-${sanitizeBranchName(chat.config.name)}-${chat.config.id.slice(0, 8)}`;
  }
}
