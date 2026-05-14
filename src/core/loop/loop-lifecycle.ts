import type { LoopCtx } from "./context";
import { createTimestamp } from "../../types/events";
import {
  loadLoop,
  updateLoopConfig,
  updateLoopState,
  deleteLoop as deleteLoopFile,
  resetStaleLoops,
} from "../../persistence/loops";
import { getWorkspace } from "../../persistence/workspaces";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import { sshSessionManager } from "../ssh-session-manager";
import { portForwardManager } from "../port-forward-manager";

async function deleteLinkedLoopChat(loopId: string): Promise<void> {
  const { chatManager } = await import("../chat-manager");
  await chatManager.deleteLoopChat(loopId);
}

async function disconnectLoopEngine(ctx: LoopCtx, loopId: string): Promise<void> {
  ctx.engines.delete(loopId);
  await backendManager.disconnectLoop(loopId);
}

async function detachLoopFromMissingWorkspace(loopId: string): Promise<void> {
  const loop = await loadLoop(loopId);
  if (!loop || !loop.config.workspaceId) {
    return;
  }

  const workspace = await getWorkspace(loop.config.workspaceId);
  if (workspace) {
    return;
  }

  await updateLoopConfig(loopId, {
    ...loop.config,
    workspaceId: "",
    updatedAt: createTimestamp(),
  });
}

async function getLoopGitCleanupContext(workspaceId: string, directory: string): Promise<{
  git: GitService;
  cleanupDirectory: string;
} | null> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    log.warn("Skipping loop git cleanup because the workspace record is missing", { workspaceId, directory });
    return null;
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const directoryExists = await executor.directoryExists(directory);
    if (!directoryExists) {
      log.warn("Skipping loop git cleanup because the workspace directory is unavailable", {
        workspaceId: workspace.id,
        directory,
      });
      return null;
    }

    return {
      git: GitService.withExecutor(executor),
      cleanupDirectory: directory,
    };
  } catch (error) {
    log.warn("Skipping loop git cleanup because the workspace host is unavailable", {
      workspaceId: workspace.id,
      directory,
      error: String(error),
    });
    return null;
  }
}

export async function deleteLoopImpl(ctx: LoopCtx, loopId: string): Promise<boolean> {
  log.info("Deleting loop", { loopId, hasActiveEngine: ctx.engines.has(loopId) });

  if (ctx.engines.has(loopId)) {
    log.debug(`[LoopManager] deleteLoop: Stopping engine for loop ${loopId}`);
    await ctx.stopLoop(loopId, "Loop deleted");
  }

  const loop = await loadLoop(loopId);
  if (!loop) {
    log.debug(`[LoopManager] deleteLoop: Loop ${loopId} not found`);
    return false;
  }
  log.debug(`[LoopManager] deleteLoop: Loaded loop ${loopId}, status: ${loop.state.status}, hasGitBranch: ${!!loop.state.git?.workingBranch}`);

  if (loop.state.git?.workingBranch) {
    log.debug(`[LoopManager] deleteLoop: Discarding git branch for loop ${loopId}`);
    const discardResult = await discardLoopImpl(ctx, loopId);
    if (!discardResult.success) {
      log.warn(`Failed to discard git branch during delete: ${discardResult.error}`);
    }
  }

  await detachLoopFromMissingWorkspace(loopId);

  log.debug(`[LoopManager] deleteLoop: Updating status to deleted for loop ${loopId}`);
  assertValidTransition(loop.state.status, "deleted", "deleteLoop");
  const updatedState = {
    ...loop.state,
    status: "deleted" as const,
    reviewMode: loop.state.reviewMode
      ? { ...loop.state.reviewMode, addressable: false }
      : undefined,
  };
  await updateLoopState(loopId, updatedState);
  log.debug(`[LoopManager] deleteLoop: Status updated to deleted for loop ${loopId}`);

  await deleteLinkedLoopChat(loopId);

  ctx.emitter.emit({
    type: "loop.deleted",
    loopId,
    timestamp: createTimestamp(),
  });

  log.info("Loop deleted", { loopId });
  return true;
}

export async function discardLoopImpl(ctx: LoopCtx, loopId: string): Promise<{ success: boolean; error?: string }> {
  log.info("Discarding loop", { loopId });
  let loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (ctx.engines.has(loopId)) {
    await ctx.stopLoop(loopId, "Loop discarded");
    loop = await ctx.getLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }
  }

  if (!loop.state.git) {
    return { success: false, error: "No git branch was created for this loop" };
  }

  try {
    await detachLoopFromMissingWorkspace(loopId);

    if (!loop.config.useWorktree) {
      const cleanupContext = await getLoopGitCleanupContext(loop.config.workspaceId, loop.config.directory);
      if (cleanupContext) {
        await cleanupContext.git.resetHard(cleanupContext.cleanupDirectory, {
          expectedBranch: loop.state.git.workingBranch,
        });
        await cleanupContext.git.checkoutBranch(cleanupContext.cleanupDirectory, loop.state.git.originalBranch);
      }
    }

    assertValidTransition(loop.state.status, "deleted", "discardLoop");
    const updatedState = {
      ...loop.state,
      status: "deleted" as const,
    };
    await updateLoopState(loopId, updatedState);

    await backendManager.disconnectLoop(loopId);

    ctx.engines.delete(loopId);

    await deleteLinkedLoopChat(loopId);

    ctx.emitter.emit({
      type: "loop.discarded",
      loopId,
      timestamp: createTimestamp(),
    });

    log.info("Loop discarded", { loopId });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function purgeLoopImpl(_ctx: LoopCtx, loopId: string): Promise<{ success: boolean; error?: string }> {
  log.info("Purging loop", { loopId });
  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  const isDraft = loop.state.status === "draft";

  if (!isDraft && loop.state.status !== "accepted_local" && loop.state.status !== "merged" && loop.state.status !== "pushed" && loop.state.status !== "deleted") {
    return { success: false, error: `Cannot purge loop in status: ${loop.state.status}. Only draft, accepted_local, merged, pushed, or deleted loops can be purged.` };
  }

  try {
    await portForwardManager.deleteForwardsByLoopId(loopId);
  } catch (error) {
    return { success: false, error: `Failed to delete linked port forwards: ${String(error)}` };
  }

  try {
    await sshSessionManager.deleteSessionByLoopId(loopId);
  } catch (error) {
    return { success: false, error: `Failed to delete linked SSH session: ${String(error)}` };
  }

  if (!isDraft) {
    try {
      await detachLoopFromMissingWorkspace(loopId);
      const cleanupContext = await getLoopGitCleanupContext(loop.config.workspaceId, loop.config.directory);
      if (cleanupContext) {
        const { git, cleanupDirectory } = cleanupContext;

        const worktreePath = loop.state.git?.worktreePath;
        if (worktreePath) {
          await git.ensureWorktreeRemoved(cleanupDirectory, worktreePath, { force: true });
          log.debug(`[LoopManager] purgeLoop: Removed worktree and pruned metadata for loop ${loopId}: ${worktreePath}`);
        }

        if (loop.config.useWorktree && loop.state.git?.workingBranch) {
          try {
            await git.deleteBranch(cleanupDirectory, loop.state.git.workingBranch);
            log.debug(`[LoopManager] purgeLoop: Deleted working branch for loop ${loopId}`);
          } catch (error) {
            log.debug(`[LoopManager] purgeLoop: Could not delete working branch: ${String(error)}`);
          }
        }

      }
    } catch (error) {
      return { success: false, error: `Failed to clean up git state during purge: ${String(error)}` };
    }
  }

  if (loop.state.reviewMode) {
    await detachLoopFromMissingWorkspace(loopId);
    loop.state.reviewMode.addressable = false;
    await updateLoopState(loopId, loop.state);
  }

  const deleted = await deleteLoopFile(loopId);
  if (!deleted) {
    return { success: false, error: "Failed to delete loop file" };
  }

  await deleteLinkedLoopChat(loopId);

  log.info("Loop purged", { loopId });
  return { success: true };
}

export async function markMergedImpl(ctx: LoopCtx, loopId: string): Promise<{ success: boolean; error?: string }> {
  log.info("Marking loop as merged", { loopId });
  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  const allowedStatuses = ["pushed", "merged"];
  if (!allowedStatuses.includes(loop.state.status)) {
    return {
      success: false,
      error: `Cannot mark loop as merged in status: ${loop.state.status}. Only finished loops can be marked as merged.`,
    };
  }

  const persistedLoop = await loadLoop(loopId);
  const gitState = persistedLoop ? persistedLoop.state.git : loop.state.git;

  if (!gitState) {
    return { success: false, error: "No git branch was created for this loop" };
  }

  try {
    const nextStatus = "merged" as const;
    if (loop.state.status === nextStatus) {
      log.info("Loop already marked as merged", { loopId });
      return { success: true };
    }
    assertValidTransition(loop.state.status, nextStatus, "markMerged");

    const updatedState = {
      ...loop.state,
      status: nextStatus,
      reviewMode: loop.state.reviewMode
        ? { ...loop.state.reviewMode, addressable: false }
        : undefined,
    };
    await updateLoopState(loopId, updatedState);

    await backendManager.disconnectLoop(loopId);

    ctx.engines.delete(loopId);

    ctx.emitter.emit({
      type: "loop.merged",
      loopId,
      timestamp: createTimestamp(),
    });

    log.info("Loop marked as merged", { loopId });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function closeLocalLoopImpl(ctx: LoopCtx, loopId: string): Promise<{ success: boolean; error?: string }> {
  log.info("Closing locally accepted loop", { loopId });
  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (loop.state.status !== "accepted_local") {
    return {
      success: false,
      error: `Cannot close local loop in status: ${loop.state.status}. Only locally accepted loops can be closed.`,
    };
  }

  if (!loop.state.reviewMode?.addressable) {
    log.info("Locally accepted loop already closed", { loopId });
    return { success: true };
  }

  try {
    assertValidTransition(loop.state.status, "accepted_local", "closeLocalLoop");
    await updateLoopState(loopId, {
      ...loop.state,
      reviewMode: {
        ...loop.state.reviewMode,
        addressable: false,
      },
    });

    await backendManager.disconnectLoop(loopId);
    ctx.engines.delete(loopId);

    log.info("Locally accepted loop closed", { loopId });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function manualCompleteLoopImpl(ctx: LoopCtx, loopId: string): Promise<{ success: boolean; error?: string }> {
  log.info("Manually completing loop", { loopId });
  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  const allowedStatuses = new Set(["stopped", "failed"]);
  if (!allowedStatuses.has(loop.state.status)) {
    return {
      success: false,
      error: `Cannot manually complete loop in status: ${loop.state.status}. Only stopped or failed loops can be manually completed.`,
    };
  }

  const persistedLoop = await loadLoop(loopId);
  const gitState = persistedLoop ? persistedLoop.state.git : loop.state.git;
  if (!gitState) {
    return { success: false, error: "No git branch was created for this loop" };
  }

  try {
    assertValidTransition(loop.state.status, "completed", "manualCompleteLoop");

    const updatedState = {
      ...loop.state,
      status: "completed" as const,
      completedAt: createTimestamp(),
      error: undefined,
      consecutiveErrors: undefined,
      git: gitState,
    };

    const engine = ctx.engines.get(loopId);
    if (engine) {
      Object.assign(engine.state, updatedState);
      await disconnectLoopEngine(ctx, loopId);
    }

    await updateLoopState(loopId, updatedState);

    ctx.emitter.emit({
      type: "loop.completed",
      loopId,
      totalIterations: loop.state.currentIteration,
      timestamp: createTimestamp(),
    });

    log.info("Loop manually completed", { loopId, previousStatus: loop.state.status });
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function shutdownImpl(ctx: LoopCtx): Promise<void> {
  const promises = Array.from(ctx.engines.keys()).map((loopId) =>
    ctx.stopLoop(loopId, "Server shutdown")
  );
  await Promise.allSettled(promises);
}

export async function forceResetAllImpl(ctx: LoopCtx): Promise<{ enginesCleared: number; loopsReset: number }> {
  const engineCount = ctx.engines.size;

  const stopPromises = Array.from(ctx.engines.entries()).map(async ([loopId, engine]) => {
    try {
      if (engine.state.status === "planning") {
        log.info(`Preserving planning loop ${loopId} status during force reset`);
        await updateLoopState(loopId, engine.state);
        await engine.abortSessionOnly();
      } else {
        await engine.stop("Force reset by user");
        await updateLoopState(loopId, engine.state);
      }
    } catch (error) {
      log.warn(`Failed to stop engine ${loopId} during force reset: ${String(error)}`);
    }
  });

  await Promise.allSettled(stopPromises);

  ctx.engines.clear();
  ctx.loopsBeingAccepted.clear();

  const loopsReset = await resetStaleLoops();

  await backendManager.resetAllConnections();

  log.info(`Force reset completed: ${engineCount} engines cleared, ${loopsReset} loops reset in database`);

  return {
    enginesCleared: engineCount,
    loopsReset,
  };
}

export function resetForTestingImpl(ctx: LoopCtx): void {
  ctx.engines.clear();
  ctx.loopsBeingAccepted.clear();
}
