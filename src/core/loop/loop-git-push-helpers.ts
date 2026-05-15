import type { LoopCtx } from "./context";
import type { LoopConfig, LoopState } from "../../types/loop";
import type { PushLoopResult } from "./loop-types";
import { LoopEngine } from "../loop-engine";
import { createTimestamp } from "../../types/events";
import { updateLoopState } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import { startStatePersistenceImpl } from "./loop-execution";
import { finalizeFullyAutonomousPushImpl } from "./loop-fully-autonomous";

interface ConflictResolutionOptions {
  onCompleted?: () => Promise<void>;
  completionDescription?: string;
  engineToReplace?: LoopEngine;
}

export async function syncWorkingBranch(
  ctx: LoopCtx,
  loopId: string,
  loop: { config: LoopConfig; state: LoopState },
  git: GitService,
  baseBranch: string,
  worktreePath: string,
  workingBranch: string,
  caller: string
): Promise<PushLoopResult | null> {
  log.debug(`[LoopManager] ${caller}: Fetching origin/${workingBranch} for loop ${loopId}`);
  const fetchSuccess = await git.fetchBranch(loop.config.directory, workingBranch);

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

  log.debug(`[LoopManager] ${caller}: Merging origin/${workingBranch} into local working branch for loop ${loopId}`);
  const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
  const mergeResult = await git.mergeWithConflictDetection(
    worktreePath,
    `origin/${workingBranch}`,
    lastCommitMessage
  );

  if (mergeResult.success) {
    log.debug(`[LoopManager] ${caller}: Clean merge with origin/${workingBranch}`);
    return null;
  }

  if (mergeResult.hasConflicts) {
    const conflictedFiles = mergeResult.conflictedFiles ?? [];
    log.debug(`[LoopManager] ${caller}: Working branch merge conflicts detected: ${conflictedFiles.join(", ")}`);

    await git.abortMerge(worktreePath);

    ctx.emitter.emit({
      type: "loop.sync.conflicts",
      loopId,
      baseBranch,
      conflictedFiles,
      timestamp: createTimestamp(),
    });

    loop.state.syncState = {
      status: "conflicts",
      baseBranch,
      autoPushOnComplete: true,
      syncPhase: "working_branch",
      mergeCommitMessage: lastCommitMessage,
    };
    assertValidTransition(loop.state.status, "resolving_conflicts", caller);
    loop.state.status = "resolving_conflicts";
    loop.state.completedAt = undefined;
    await updateLoopState(loopId, loop.state);

    return startConflictResolutionEngine(
      ctx, loopId, loop, git, `origin/${workingBranch}`, conflictedFiles
    );
  }

  const errorMsg = mergeResult.stderr || "Unknown merge error";
  log.error(`[LoopManager] ${caller}: Working branch merge failed for loop ${loopId}: ${errorMsg}`);
  return {
    success: false,
    error: `Failed to merge origin/${workingBranch}: ${errorMsg}`,
  };
}

export async function syncBaseBranchAndPush(
  ctx: LoopCtx,
  loopId: string,
  loop: { config: LoopConfig; state: LoopState },
  git: GitService
): Promise<PushLoopResult> {
  const baseBranch = loop.config.baseBranch ?? loop.state.git!.originalBranch;
  const worktreePath = loop.state.git!.worktreePath ?? loop.config.directory;

  ctx.emitter.emit({
    type: "loop.sync.started",
    loopId,
    baseBranch,
    timestamp: createTimestamp(),
  });

  log.debug(`[LoopManager] syncBaseBranchAndPush: Fetching origin/${baseBranch} for loop ${loopId}`);
  const fetchSuccess = await git.fetchBranch(loop.config.directory, baseBranch);

  let alreadyUpToDate: boolean;
  if (!fetchSuccess) {
    log.debug(`[LoopManager] syncBaseBranchAndPush: Could not fetch origin/${baseBranch}, skipping sync`);
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
    log.debug(`[LoopManager] syncBaseBranchAndPush: Already up to date with origin/${baseBranch}`);
    syncStatus = "already_up_to_date";

    ctx.emitter.emit({
      type: "loop.sync.clean",
      loopId,
      baseBranch,
      timestamp: createTimestamp(),
    });
  } else {
    log.debug(`[LoopManager] syncBaseBranchAndPush: Merging origin/${baseBranch} into working branch for loop ${loopId}`);
    const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
    const mergeResult = await git.mergeWithConflictDetection(
      worktreePath,
      `origin/${baseBranch}`,
      lastCommitMessage
    );

    if (mergeResult.success) {
      log.debug(`[LoopManager] syncBaseBranchAndPush: Clean merge with origin/${baseBranch}`);
      syncStatus = "clean";

      ctx.emitter.emit({
        type: "loop.sync.clean",
        loopId,
        baseBranch,
        timestamp: createTimestamp(),
      });
    } else if (mergeResult.hasConflicts) {
      const conflictedFiles = mergeResult.conflictedFiles ?? [];
      log.debug(`[LoopManager] syncBaseBranchAndPush: Merge conflicts detected with origin/${baseBranch}: ${conflictedFiles.join(", ")}`);

      await git.abortMerge(worktreePath);

      ctx.emitter.emit({
        type: "loop.sync.conflicts",
        loopId,
        baseBranch,
        conflictedFiles,
        timestamp: createTimestamp(),
      });

      loop.state.syncState = {
        status: "conflicts",
        baseBranch,
        autoPushOnComplete: true,
        syncPhase: "base_branch",
        mergeCommitMessage: lastCommitMessage,
      };
      assertValidTransition(loop.state.status, "resolving_conflicts", "syncBaseBranchAndPush");
      loop.state.status = "resolving_conflicts";
      loop.state.completedAt = undefined;
      await updateLoopState(loopId, loop.state);

      return startConflictResolutionEngine(
        ctx, loopId, loop, git, `origin/${baseBranch}`, conflictedFiles
      );
    } else {
      const errorMsg = mergeResult.stderr || "Unknown merge error";
      log.error(`[LoopManager] syncBaseBranchAndPush: Merge failed (not conflicts) for loop ${loopId}: ${errorMsg}`);
      return {
        success: false,
        error: `Failed to merge origin/${baseBranch}: ${errorMsg}`,
      };
    }
  }

  const remoteBranch = await pushAndFinalize(ctx, loopId, loop, git, "syncBaseBranchAndPush");

  return { success: true, remoteBranch, syncStatus };
}

export async function syncBaseBranchBeforeExecution(
  ctx: LoopCtx,
  loopId: string,
  loop: { config: LoopConfig; state: LoopState },
  git: GitService,
  onConflictsResolved: () => Promise<void>,
  currentEngine?: LoopEngine,
): Promise<PushLoopResult> {
  const baseBranch = loop.config.baseBranch ?? loop.state.git!.originalBranch;
  const worktreePath = loop.state.git!.worktreePath ?? loop.config.directory;

  loop.state.syncState = {
    status: "syncing",
    baseBranch,
    autoPushOnComplete: false,
    syncPhase: "base_branch",
  };
  await updateLoopState(loopId, loop.state);

  ctx.emitter.emit({
    type: "loop.sync.started",
    loopId,
    baseBranch,
    timestamp: createTimestamp(),
  });

  log.debug(`[LoopManager] syncBaseBranchBeforeExecution: Fetching origin/${baseBranch} for loop ${loopId}`);
  const fetchSuccess = await git.fetchBranch(loop.config.directory, baseBranch);

  let alreadyUpToDate: boolean;
  if (!fetchSuccess) {
    const error = `Failed to fetch origin/${baseBranch} before accepted plan execution`;
    log.error(`[LoopManager] syncBaseBranchBeforeExecution: ${error} for loop ${loopId}`);
    loop.state.syncState = undefined;
    await updateLoopState(loopId, loop.state);

    ctx.emitter.emit({
      type: "loop.sync.failed",
      loopId,
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
    log.debug(`[LoopManager] syncBaseBranchBeforeExecution: Already up to date with origin/${baseBranch}`);
    loop.state.syncState = undefined;
    await updateLoopState(loopId, loop.state);

    ctx.emitter.emit({
      type: "loop.sync.clean",
      loopId,
      baseBranch,
      timestamp: createTimestamp(),
    });
    return {
      success: true,
      syncStatus: "already_up_to_date",
    };
  }

  log.debug(`[LoopManager] syncBaseBranchBeforeExecution: Merging origin/${baseBranch} into working branch for loop ${loopId}`);
  const lastCommitMessage = await git.getLastCommitMessage(worktreePath);
  const mergeResult = await git.mergeWithConflictDetection(
    worktreePath,
    `origin/${baseBranch}`,
    lastCommitMessage,
  );

  if (mergeResult.success) {
    log.debug(`[LoopManager] syncBaseBranchBeforeExecution: Clean merge with origin/${baseBranch}`);
    loop.state.syncState = undefined;
    await updateLoopState(loopId, loop.state);

    ctx.emitter.emit({
      type: "loop.sync.clean",
      loopId,
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
    log.debug(`[LoopManager] syncBaseBranchBeforeExecution: Merge conflicts detected with origin/${baseBranch}: ${conflictedFiles.join(", ")}`);

    await git.abortMerge(worktreePath);

    ctx.emitter.emit({
      type: "loop.sync.conflicts",
      loopId,
      baseBranch,
      conflictedFiles,
      timestamp: createTimestamp(),
    });

    loop.state.syncState = {
      status: "conflicts",
      baseBranch,
      autoPushOnComplete: false,
      syncPhase: "base_branch",
      mergeCommitMessage: lastCommitMessage,
    };
    assertValidTransition(loop.state.status, "resolving_conflicts", "syncBaseBranchBeforeExecution");
    loop.state.status = "resolving_conflicts";
    loop.state.completedAt = undefined;
    await updateLoopState(loopId, loop.state);

    return startConflictResolutionEngine(
      ctx,
      loopId,
      loop,
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
  log.error(`[LoopManager] syncBaseBranchBeforeExecution: Merge failed (not conflicts) for loop ${loopId}: ${errorMsg}`);
  loop.state.syncState = undefined;
  await updateLoopState(loopId, loop.state);
  ctx.emitter.emit({
    type: "loop.sync.failed",
    loopId,
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
  ctx: LoopCtx,
  loopId: string,
  loop: { config: LoopConfig; state: LoopState },
  git: GitService,
  caller: string
): Promise<string> {
  const remoteBranch = await git.pushBranch(
    loop.config.directory,
    loop.state.git!.workingBranch
  );

  const reviewMode = loop.state.reviewMode
    ? {
        ...loop.state.reviewMode,
        addressable: true,
        completionAction: "push" as const,
      }
    : {
        addressable: true,
        completionAction: "push" as const,
        reviewCycles: 0,
      };

  assertValidTransition(loop.state.status, "pushed", caller);
  const updatedState = {
    ...loop.state,
    status: "pushed" as const,
    reviewMode,
    pullRequestMonitoring: undefined,
    syncState: undefined,
  };
  await updateLoopState(loopId, updatedState);

  await backendManager.disconnectLoop(loopId);

  ctx.engines.delete(loopId);

  ctx.emitter.emit({
    type: "loop.pushed",
    loopId,
    remoteBranch,
    timestamp: createTimestamp(),
  });

  return remoteBranch;
}

async function startConflictResolutionEngine(
  ctx: LoopCtx,
  loopId: string,
  loop: { config: LoopConfig; state: LoopState },
  git: GitService,
  sourceBranch: string,
  conflictedFiles: string[],
  options: ConflictResolutionOptions = {},
): Promise<PushLoopResult> {
  const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);

  const conflictPrompt = constructConflictResolutionPrompt(
    sourceBranch, conflictedFiles, loop.state.syncState?.mergeCommitMessage
  );

  if (options.engineToReplace) {
    await handOffEngineForConflictResolution(ctx, loopId, options.engineToReplace);
  }

  const engine = new LoopEngine({
    loop: { config: loop.config, state: loop.state },
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
      if (state.status === "completed" && state.syncState?.autoPushOnComplete) {
        handleConflictResolutionComplete(ctx, loopId).catch((error) => {
          log.error(`[LoopManager] Auto-push after conflict resolution failed for loop ${loopId}:`, String(error));
        });
      }
      if (state.status === "completed" && !state.syncState?.autoPushOnComplete && options.onCompleted) {
        options.onCompleted().catch((error) => {
          log.error(
            `[LoopManager] ${options.completionDescription ?? "Post-conflict completion"} failed for loop ${loopId}:`,
            String(error),
          );
        });
      }
      if (state.status === "failed" || state.status === "max_iterations") {
        if (state.syncState?.autoPushOnComplete) {
          state.syncState.autoPushOnComplete = false;
          await updateLoopState(loopId, state);
        } else if (options.onCompleted && state.syncState) {
          log.warn(
            `[LoopManager] ${options.completionDescription ?? "Post-conflict completion"} aborted because conflict resolution ended in ${state.status} for loop ${loopId}`,
          );
          state.syncState = undefined;
          await updateLoopState(loopId, state);
        }
      }
    },
    skipGitSetup: true,
  });
  ctx.engines.set(loopId, engine);

  engine.setPendingPrompt(conflictPrompt);

  startStatePersistenceImpl(ctx, loopId);

  engine.start().catch((error) => {
    log.error(`Loop ${loopId} failed to start for conflict resolution:`, String(error));
  });

  return {
    success: true,
    syncStatus: "conflicts_being_resolved",
  };
}

async function handOffEngineForConflictResolution(
  ctx: LoopCtx,
  loopId: string,
  engine: LoopEngine,
): Promise<void> {
  await engine.waitForLoopIdle();
  await engine.abortSessionOnly("Accepted plan entering conflict resolution");

  if (ctx.engines.get(loopId) === engine) {
    ctx.engines.delete(loopId);
  }
}

async function handleConflictResolutionComplete(ctx: LoopCtx, loopId: string): Promise<void> {
  log.debug(`[LoopManager] handleConflictResolutionComplete: Processing loop ${loopId}`);

  ctx.engines.delete(loopId);

  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    log.error(`[LoopManager] handleConflictResolutionComplete: Loop ${loopId} not found`);
    return;
  }

  if (!loop.state.git) {
    log.error(`[LoopManager] handleConflictResolutionComplete: No git state for loop ${loopId}`);
    return;
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
    const git = GitService.withExecutor(executor);

    if (loop.state.syncState?.syncPhase === "working_branch") {
      log.debug(`[LoopManager] handleConflictResolutionComplete: Working branch conflicts resolved, continuing with base branch sync for loop ${loopId}`);

      loop.state.syncState.syncPhase = "base_branch";
      await updateLoopState(loopId, loop.state);

      const result = await syncBaseBranchAndPush(ctx, loopId, loop, git);
      if (!result.success && result.error) {
        log.error(`[LoopManager] handleConflictResolutionComplete: Base branch sync failed for loop ${loopId}: ${result.error}`);
      } else if (result.syncStatus === "conflicts_being_resolved") {
        log.debug(`[LoopManager] handleConflictResolutionComplete: Base branch also has conflicts for loop ${loopId}, new resolution started`);
      } else {
        log.info(`[LoopManager] handleConflictResolutionComplete: Successfully synced and pushed loop ${loopId} to ${result.remoteBranch}`);
        await finalizeFullyAutonomousPushImpl(ctx, loopId);
      }
      return;
    }

    log.debug(`[LoopManager] handleConflictResolutionComplete: Auto-pushing loop ${loopId}`);

    const remoteBranch = await pushAndFinalize(ctx, loopId, loop, git, "handleConflictResolutionComplete");

    log.info(`[LoopManager] handleConflictResolutionComplete: Successfully auto-pushed loop ${loopId} to ${remoteBranch}`);
    await finalizeFullyAutonomousPushImpl(ctx, loopId);
  } catch (error) {
    log.error(`[LoopManager] handleConflictResolutionComplete: Failed to auto-push loop ${loopId}:`, String(error));
    if (loop.state.syncState) {
      loop.state.syncState.autoPushOnComplete = false;
    }
    await updateLoopState(loopId, loop.state);
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
