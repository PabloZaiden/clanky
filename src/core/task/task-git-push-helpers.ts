import type { TaskCtx } from "./context";
import type { TaskConfig, TaskState } from "../../types/task";
import type { PushTaskResult } from "./task-types";
import { TaskEngine } from "../task-engine";
import { createTimestamp } from "../../types/events";
import { updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { startStatePersistenceImpl } from "./task-execution";
import { finalizeFullyAutonomousPushImpl } from "./task-fully-autonomous";

interface ConflictResolutionOptions {
  onCompleted?: () => Promise<void>;
  completionDescription?: string;
  engineToReplace?: TaskEngine;
}

export async function syncWorkingBranch(
  ctx: TaskCtx,
  taskId: string,
  task: { config: TaskConfig; state: TaskState },
  git: GitService,
  baseBranch: string,
  worktreePath: string,
  workingBranch: string,
  caller: string
): Promise<PushTaskResult | null> {
  log.debug(`[TaskManager] ${caller}: Fetching origin/${workingBranch} for task ${taskId}`);
  const fetchSuccess = await git.fetchBranch(task.config.directory, workingBranch);

  if (!fetchSuccess) {
    return null;
  }

  const upToDate = await git.isAncestor(
    worktreePath,
    `origin/${workingBranch}`,
    "HEAD"
  );

  if (upToDate) {
    return null;
  }

  log.debug(`[TaskManager] ${caller}: Merging origin/${workingBranch} into local working branch for task ${taskId}`);
  const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
  const mergeResult = await git.mergeWithConflictDetection(
    worktreePath,
    `origin/${workingBranch}`,
    lastCommitMessage
  );

  if (mergeResult.success) {
    log.debug(`[TaskManager] ${caller}: Clean merge with origin/${workingBranch}`);
    return null;
  }

  if (mergeResult.hasConflicts) {
    const conflictedFiles = mergeResult.conflictedFiles ?? [];
    log.debug(`[TaskManager] ${caller}: Working branch merge conflicts detected: ${conflictedFiles.join(", ")}`);

    await git.abortMerge(worktreePath);

    ctx.emitter.emit({
      type: "task.sync.conflicts",
      taskId,
      baseBranch,
      conflictedFiles,
      timestamp: createTimestamp(),
    });

    task.state.syncState = {
      status: "conflicts",
      baseBranch,
      autoPushOnComplete: true,
      syncPhase: "working_branch",
      mergeCommitMessage: lastCommitMessage,
    };
    assertValidTransition(task.state.status, "resolving_conflicts", caller);
    task.state.status = "resolving_conflicts";
    task.state.completedAt = undefined;
    await updateTaskState(taskId, task.state);

    return startConflictResolutionEngine(
      ctx, taskId, task, git, `origin/${workingBranch}`, conflictedFiles
    );
  }

  const errorMsg = mergeResult.stderr || "Unknown merge error";
  log.error(`[TaskManager] ${caller}: Working branch merge failed for task ${taskId}: ${errorMsg}`);
  return {
    success: false,
    error: `Failed to merge origin/${workingBranch}: ${errorMsg}`,
  };
}

export async function syncBaseBranchAndPush(
  ctx: TaskCtx,
  taskId: string,
  task: { config: TaskConfig; state: TaskState },
  git: GitService
): Promise<PushTaskResult> {
  const baseBranch = task.config.baseBranch ?? task.state.git!.originalBranch;
  const worktreePath = task.state.git!.worktreePath ?? task.config.directory;

  ctx.emitter.emit({
    type: "task.sync.started",
    taskId,
    baseBranch,
    timestamp: createTimestamp(),
  });

  log.debug(`[TaskManager] syncBaseBranchAndPush: Fetching origin/${baseBranch} for task ${taskId}`);
  const fetchSuccess = await git.fetchBranch(task.config.directory, baseBranch);

  let alreadyUpToDate: boolean;
  if (!fetchSuccess) {
    log.debug(`[TaskManager] syncBaseBranchAndPush: Could not fetch origin/${baseBranch}, skipping sync`);
    alreadyUpToDate = true;
  } else {
    alreadyUpToDate = await git.isAncestor(
      worktreePath,
      `origin/${baseBranch}`,
      "HEAD"
    );
  }

  let syncStatus: "already_up_to_date" | "clean" | "conflicts_being_resolved";

  if (alreadyUpToDate) {
    log.debug(`[TaskManager] syncBaseBranchAndPush: Already up to date with origin/${baseBranch}`);
    syncStatus = "already_up_to_date";

    ctx.emitter.emit({
      type: "task.sync.clean",
      taskId,
      baseBranch,
      timestamp: createTimestamp(),
    });
  } else {
    log.debug(`[TaskManager] syncBaseBranchAndPush: Merging origin/${baseBranch} into working branch for task ${taskId}`);
    const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
    const mergeResult = await git.mergeWithConflictDetection(
      worktreePath,
      `origin/${baseBranch}`,
      lastCommitMessage
    );

    if (mergeResult.success) {
      log.debug(`[TaskManager] syncBaseBranchAndPush: Clean merge with origin/${baseBranch}`);
      syncStatus = "clean";

      ctx.emitter.emit({
        type: "task.sync.clean",
        taskId,
        baseBranch,
        timestamp: createTimestamp(),
      });
    } else if (mergeResult.hasConflicts) {
      const conflictedFiles = mergeResult.conflictedFiles ?? [];
      log.debug(`[TaskManager] syncBaseBranchAndPush: Merge conflicts detected with origin/${baseBranch}: ${conflictedFiles.join(", ")}`);

      await git.abortMerge(worktreePath);

      ctx.emitter.emit({
        type: "task.sync.conflicts",
        taskId,
        baseBranch,
        conflictedFiles,
        timestamp: createTimestamp(),
      });

      task.state.syncState = {
        status: "conflicts",
        baseBranch,
        autoPushOnComplete: true,
        syncPhase: "base_branch",
        mergeCommitMessage: lastCommitMessage,
      };
      assertValidTransition(task.state.status, "resolving_conflicts", "syncBaseBranchAndPush");
      task.state.status = "resolving_conflicts";
      task.state.completedAt = undefined;
      await updateTaskState(taskId, task.state);

      return startConflictResolutionEngine(
        ctx, taskId, task, git, `origin/${baseBranch}`, conflictedFiles
      );
    } else {
      const errorMsg = mergeResult.stderr || "Unknown merge error";
      log.error(`[TaskManager] syncBaseBranchAndPush: Merge failed (not conflicts) for task ${taskId}: ${errorMsg}`);
      return {
        success: false,
        error: `Failed to merge origin/${baseBranch}: ${errorMsg}`,
      };
    }
  }

  const remoteBranch = await pushAndFinalize(ctx, taskId, task, git, "syncBaseBranchAndPush");

  return { success: true, remoteBranch, syncStatus };
}

export async function syncBaseBranchBeforeExecution(
  ctx: TaskCtx,
  taskId: string,
  task: { config: TaskConfig; state: TaskState },
  git: GitService,
  onConflictsResolved: () => Promise<void>,
  currentEngine?: TaskEngine,
): Promise<PushTaskResult> {
  const baseBranch = task.config.baseBranch ?? task.state.git!.originalBranch;
  const worktreePath = task.state.git!.worktreePath ?? task.config.directory;

  task.state.syncState = {
    status: "syncing",
    baseBranch,
    autoPushOnComplete: false,
    syncPhase: "base_branch",
  };
  await updateTaskState(taskId, task.state);

  ctx.emitter.emit({
    type: "task.sync.started",
    taskId,
    baseBranch,
    timestamp: createTimestamp(),
  });

  log.debug(`[TaskManager] syncBaseBranchBeforeExecution: Fetching origin/${baseBranch} for task ${taskId}`);
  const fetchSuccess = await git.fetchBranch(task.config.directory, baseBranch);

  let alreadyUpToDate: boolean;
  if (!fetchSuccess) {
    const error = `Failed to fetch origin/${baseBranch} before accepted plan execution`;
    log.error(`[TaskManager] syncBaseBranchBeforeExecution: ${error} for task ${taskId}`);
    task.state.syncState = undefined;
    await updateTaskState(taskId, task.state);

    ctx.emitter.emit({
      type: "task.sync.failed",
      taskId,
      baseBranch,
      error,
      timestamp: createTimestamp(),
    });

    return {
      success: false,
      error,
    };
  } else {
    alreadyUpToDate = await git.isAncestor(
      worktreePath,
      `origin/${baseBranch}`,
      "HEAD",
    );
  }

  if (alreadyUpToDate) {
    log.debug(`[TaskManager] syncBaseBranchBeforeExecution: Already up to date with origin/${baseBranch}`);
    task.state.syncState = undefined;
    await updateTaskState(taskId, task.state);

    ctx.emitter.emit({
      type: "task.sync.clean",
      taskId,
      baseBranch,
      timestamp: createTimestamp(),
    });
    return {
      success: true,
      syncStatus: "already_up_to_date",
    };
  }

  log.debug(`[TaskManager] syncBaseBranchBeforeExecution: Merging origin/${baseBranch} into working branch for task ${taskId}`);
  const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
  const mergeResult = await git.mergeWithConflictDetection(
    worktreePath,
    `origin/${baseBranch}`,
    lastCommitMessage,
  );

  if (mergeResult.success) {
    log.debug(`[TaskManager] syncBaseBranchBeforeExecution: Clean merge with origin/${baseBranch}`);
    task.state.syncState = undefined;
    await updateTaskState(taskId, task.state);

    ctx.emitter.emit({
      type: "task.sync.clean",
      taskId,
      baseBranch,
      timestamp: createTimestamp(),
    });
    return {
      success: true,
      syncStatus: "clean",
    };
  }

  if (mergeResult.hasConflicts) {
    const conflictedFiles = mergeResult.conflictedFiles ?? [];
    log.debug(`[TaskManager] syncBaseBranchBeforeExecution: Merge conflicts detected with origin/${baseBranch}: ${conflictedFiles.join(", ")}`);

    await git.abortMerge(worktreePath);

    ctx.emitter.emit({
      type: "task.sync.conflicts",
      taskId,
      baseBranch,
      conflictedFiles,
      timestamp: createTimestamp(),
    });

    task.state.syncState = {
      status: "conflicts",
      baseBranch,
      autoPushOnComplete: false,
      syncPhase: "base_branch",
      mergeCommitMessage: lastCommitMessage,
    };
    assertValidTransition(task.state.status, "resolving_conflicts", "syncBaseBranchBeforeExecution");
    task.state.status = "resolving_conflicts";
    task.state.completedAt = undefined;
    await updateTaskState(taskId, task.state);

    return startConflictResolutionEngine(
      ctx,
      taskId,
      task,
      git,
      `origin/${baseBranch}`,
      conflictedFiles,
      {
        onCompleted: onConflictsResolved,
        completionDescription: "Resume accepted plan execution",
        engineToReplace: currentEngine,
      },
    );
  }

  const errorMsg = mergeResult.stderr || "Unknown merge error";
  log.error(`[TaskManager] syncBaseBranchBeforeExecution: Merge failed (not conflicts) for task ${taskId}: ${errorMsg}`);
  task.state.syncState = undefined;
  await updateTaskState(taskId, task.state);
  ctx.emitter.emit({
    type: "task.sync.failed",
    taskId,
    baseBranch,
    error: errorMsg,
    timestamp: createTimestamp(),
  });
  return {
    success: false,
    error: `Failed to merge origin/${baseBranch}: ${errorMsg}`,
  };
}

export async function pushAndFinalize(
  ctx: TaskCtx,
  taskId: string,
  task: { config: TaskConfig; state: TaskState },
  git: GitService,
  caller: string
): Promise<string> {
  const remoteBranch = await git.pushBranch(
    task.config.directory,
    task.state.git!.workingBranch
  );

  const reviewMode = task.state.reviewMode
    ? {
        ...task.state.reviewMode,
        addressable: true,
        completionAction: "push" as const,
      }
    : {
        addressable: true,
        completionAction: "push" as const,
        reviewCycles: 0,
      };

  assertValidTransition(task.state.status, "pushed", caller);
  const updatedState = {
    ...task.state,
    status: "pushed" as const,
    reviewMode,
    pullRequestMonitoring: undefined,
    syncState: undefined,
  };
  await updateTaskState(taskId, updatedState);

  await backendManager.disconnectTask(taskId);

  ctx.engines.delete(taskId);

  ctx.emitter.emit({
    type: "task.pushed",
    taskId,
    remoteBranch,
    timestamp: createTimestamp(),
  });

  return remoteBranch;
}

async function startConflictResolutionEngine(
  ctx: TaskCtx,
  taskId: string,
  task: { config: TaskConfig; state: TaskState },
  git: GitService,
  sourceBranch: string,
  conflictedFiles: string[],
  options: ConflictResolutionOptions = {},
): Promise<PushTaskResult> {
  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);

  const conflictPrompt = constructConflictResolutionPrompt(
    sourceBranch, conflictedFiles, task.state.syncState?.mergeCommitMessage
  );

  if (options.engineToReplace) {
    await handOffEngineForConflictResolution(ctx, taskId, options.engineToReplace);
  }

  const engine = new TaskEngine({
    task: { config: task.config, state: task.state },
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateTaskState(taskId, state);
      if (state.status === "completed" && state.syncState?.autoPushOnComplete) {
        handleConflictResolutionComplete(ctx, taskId).catch((error) => {
          log.error(`[TaskManager] Auto-push after conflict resolution failed for task ${taskId}:`, String(error));
        });
      }
      if (state.status === "completed" && !state.syncState?.autoPushOnComplete && options.onCompleted) {
        options.onCompleted().catch((error) => {
          log.error(
            `[TaskManager] ${options.completionDescription ?? "Post-conflict completion"} failed for task ${taskId}:`,
            String(error),
          );
        });
      }
      if (state.status === "failed" || state.status === "max_iterations") {
        if (state.syncState?.autoPushOnComplete) {
          state.syncState.autoPushOnComplete = false;
          await updateTaskState(taskId, state);
        } else if (options.onCompleted && state.syncState) {
          log.warn(
            `[TaskManager] ${options.completionDescription ?? "Post-conflict completion"} aborted because conflict resolution ended in ${state.status} for task ${taskId}`,
          );
          state.syncState = undefined;
          await updateTaskState(taskId, state);
        }
      }
    },
    skipGitSetup: true,
  });
  ctx.engines.set(taskId, engine);

  engine.setPendingPrompt(conflictPrompt);

  startStatePersistenceImpl(ctx, taskId);

  engine.start().catch((error) => {
    log.error(`Task ${taskId} failed to start for conflict resolution:`, String(error));
  });

  return {
    success: true,
    syncStatus: "conflicts_being_resolved",
  };
}

async function handOffEngineForConflictResolution(
  ctx: TaskCtx,
  taskId: string,
  engine: TaskEngine,
): Promise<void> {
  await engine.waitForTaskIdle();
  await engine.abortSessionOnly("Accepted plan entering conflict resolution");

  if (ctx.engines.get(taskId) === engine) {
    ctx.engines.delete(taskId);
  }
}

async function handleConflictResolutionComplete(ctx: TaskCtx, taskId: string): Promise<void> {
  log.debug(`[TaskManager] handleConflictResolutionComplete: Processing task ${taskId}`);

  ctx.engines.delete(taskId);

  const task = await ctx.getTask(taskId);
  if (!task) {
    log.error(`[TaskManager] handleConflictResolutionComplete: Task ${taskId} not found`);
    return;
  }

  if (!task.state.git) {
    log.error(`[TaskManager] handleConflictResolutionComplete: No git state for task ${taskId}`);
    return;
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
    const git = GitService.withExecutor(executor);

    if (task.state.syncState?.syncPhase === "working_branch") {
      log.debug(`[TaskManager] handleConflictResolutionComplete: Working branch conflicts resolved, continuing with base branch sync for task ${taskId}`);

      task.state.syncState.syncPhase = "base_branch";
      await updateTaskState(taskId, task.state);

      const result = await syncBaseBranchAndPush(ctx, taskId, task, git);
      if (!result.success && result.error) {
        log.error(`[TaskManager] handleConflictResolutionComplete: Base branch sync failed for task ${taskId}: ${result.error}`);
      } else if (result.syncStatus === "conflicts_being_resolved") {
        log.debug(`[TaskManager] handleConflictResolutionComplete: Base branch also has conflicts for task ${taskId}, new resolution started`);
      } else {
        log.info(`[TaskManager] handleConflictResolutionComplete: Successfully synced and pushed task ${taskId} to ${result.remoteBranch}`);
        await finalizeFullyAutonomousPushImpl(ctx, taskId);
      }
      return;
    }

    log.debug(`[TaskManager] handleConflictResolutionComplete: Auto-pushing task ${taskId}`);

    const remoteBranch = await pushAndFinalize(ctx, taskId, task, git, "handleConflictResolutionComplete");

    log.info(`[TaskManager] handleConflictResolutionComplete: Successfully auto-pushed task ${taskId} to ${remoteBranch}`);
    await finalizeFullyAutonomousPushImpl(ctx, taskId);
  } catch (error) {
    log.error(`[TaskManager] handleConflictResolutionComplete: Failed to auto-push task ${taskId}:`, String(error));
    if (task.state.syncState) {
      task.state.syncState.autoPushOnComplete = false;
    }
    await updateTaskState(taskId, task.state);
  }
}

/**
 * Safely single-quotes a string for use as a POSIX shell argument.
 * This ensures that characters like $, `, and $() are not expanded when pasted into a shell.
 */
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function constructConflictResolutionPrompt(sourceBranch: string, conflictedFiles: string[], mergeCommitMessage?: string): string {
  const fileList = conflictedFiles.map(f => `- ${f}`).join("\n");
  const commitInstruction = mergeCommitMessage
    ? `git commit -m ${shellSingleQuote(mergeCommitMessage)}`
    : "git commit --no-edit";
  return `The branch (${sourceBranch}) has diverged from your working branch and there are merge conflicts that need to be resolved before pushing.

Merge the branch and resolve all conflicts:

1. Run: git merge ${sourceBranch}
2. The following files have conflicts:
${fileList}
3. For each conflicted file:
   - Open the file and examine the conflict markers (<<<<<<<, =======, >>>>>>>)
   - Resolve each conflict by keeping the correct code (merge both sides appropriately)
   - Remove all conflict markers
   - Stage the resolved file with: git add <file>
4. After ALL conflicts are resolved and staged, complete the merge: ${commitInstruction}
5. Verify the code still compiles/works correctly after the merge
6. When all conflicts are resolved and the merge is complete, end your response with:

<promise>COMPLETE</promise>`;
}
