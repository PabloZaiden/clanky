import type { LoopCtx } from "./context";
import type { PushLoopResult } from "./loop-types";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { syncWorkingBranch, syncBaseBranchAndPush } from "./loop-git-push-helpers";

export async function pushLoopImpl(ctx: LoopCtx, loopId: string): Promise<PushLoopResult> {
  if (ctx.loopsBeingAccepted.has(loopId)) {
    log.warn(`[LoopManager] pushLoop: Already processing loop ${loopId}, ignoring duplicate call`);
    return { success: false, error: "Operation already in progress" };
  }

  const loop = await ctx.getLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (
    loop.state.status !== "completed" &&
    loop.state.status !== "max_iterations" &&
    loop.state.status !== "accepted_local"
  ) {
    return { success: false, error: `Cannot push loop in status: ${loop.state.status}` };
  }

  if (!loop.state.git) {
    return { success: false, error: "No git branch was created for this loop" };
  }

  ctx.loopsBeingAccepted.add(loopId);
  log.info(`[LoopManager] pushLoop: Starting push for loop ${loopId}`);

  try {
    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
    const git = GitService.withExecutor(executor);

    const baseBranch = loop.config.baseBranch ?? loop.state.git.originalBranch;
    const worktreePath = loop.state.git.worktreePath ?? loop.config.directory;
    const workingBranch = loop.state.git.workingBranch;

    await git.ensureMergeStrategy(worktreePath);

    if (!(await git.hasRemote(loop.config.directory))) {
      return {
        success: false,
        error: "Workspace has no git remote configured. Add an origin remote before pushing this loop.",
      };
    }

    const workingBranchConflictResult = await syncWorkingBranch(
      ctx, loopId, loop, git, baseBranch, worktreePath, workingBranch, "pushLoop"
    );
    if (workingBranchConflictResult) {
      return workingBranchConflictResult;
    }

    return await syncBaseBranchAndPush(ctx, loopId, loop, git);
  } catch (error) {
    log.error("[LoopManager] pushLoop: Failed to push loop", {
      loopId,
      error: String(error),
    });
    return { success: false, error: String(error) };
  } finally {
    ctx.loopsBeingAccepted.delete(loopId);
    log.debug(`[LoopManager] pushLoop: Finished push for loop ${loopId}`);
  }
}

export async function updateBranchImpl(ctx: LoopCtx, loopId: string): Promise<PushLoopResult> {
  if (ctx.loopsBeingAccepted.has(loopId)) {
    log.warn(`[LoopManager] updateBranch: Already processing loop ${loopId}, ignoring duplicate call`);
    return { success: false, error: "Operation already in progress" };
  }
  ctx.loopsBeingAccepted.add(loopId);
  log.info(`[LoopManager] updateBranch: Starting branch update for loop ${loopId}`);

  try {
    const loop = await ctx.getLoop(loopId);
    if (!loop) {
      return { success: false, error: "Loop not found" };
    }

    if (loop.state.status !== "pushed") {
      return { success: false, error: `Cannot update branch for loop in status: ${loop.state.status}` };
    }

    if (!loop.state.git) {
      return { success: false, error: "No git branch was created for this loop" };
    }

    if (ctx.engines.has(loopId)) {
      return { success: false, error: "Loop already has an active engine running" };
    }

    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
    const git = GitService.withExecutor(executor);

    const baseBranch = loop.config.baseBranch ?? loop.state.git.originalBranch;
    const worktreePath = loop.state.git.worktreePath ?? loop.config.directory;
    const workingBranch = loop.state.git.workingBranch;

    await git.ensureMergeStrategy(worktreePath);

    if (!(await git.hasRemote(loop.config.directory))) {
      return {
        success: false,
        error: "Workspace has no git remote configured. Add an origin remote before updating this loop branch.",
      };
    }

    const workingBranchConflictResult = await syncWorkingBranch(
      ctx, loopId, loop, git, baseBranch, worktreePath, workingBranch, "updateBranch"
    );
    if (workingBranchConflictResult) {
      return workingBranchConflictResult;
    }

    return await syncBaseBranchAndPush(ctx, loopId, loop, git);
  } catch (error) {
    log.error("[LoopManager] updateBranch: Failed to update branch for loop", {
      loopId,
      error: String(error),
    });
    return { success: false, error: String(error) };
  } finally {
    ctx.loopsBeingAccepted.delete(loopId);
    log.debug(`[LoopManager] updateBranch: Finished branch update for loop ${loopId}`);
  }
}
