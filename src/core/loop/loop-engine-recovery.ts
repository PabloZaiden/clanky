import type { LoopCtx } from "./context";
import { LoopEngine } from "../loop-engine";
import { loadLoop, updateLoopState } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { getLoopWorkingDirectory } from "./loop-types";
import { ensureLoopBranchCheckedOutImpl } from "./loop-git-validation";
import { startStatePersistenceImpl } from "./loop-state-persistence";

export async function recoverPlanningEngineImpl(ctx: LoopCtx, loopId: string): Promise<LoopEngine> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }

  if (loop.state.status !== "planning") {
    throw new Error("Loop plan mode is not running");
  }

  const workingDirectory = getLoopWorkingDirectory(loop);
  if (!workingDirectory) {
    throw new Error("Loop is configured to use a worktree, but no worktree path is available - cannot recreate engine for planning recovery");
  }
  const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, workingDirectory);
  const git = GitService.withExecutor(executor);
  await ensureLoopBranchCheckedOutImpl(ctx, loop, git, workingDirectory);
  const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);

  const engine = new LoopEngine({
    loop,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
    },
  });

  ctx.engines.set(loopId, engine);

  try {
    await engine.reconnectSession();
  } catch (error) {
    ctx.engines.delete(loopId);
    throw new Error(
      `Failed to recover planning engine session for loop ${loopId}: ${String(error)}`,
      { cause: error },
    );
  }

  startStatePersistenceImpl(ctx, loopId);

  return engine;
}
