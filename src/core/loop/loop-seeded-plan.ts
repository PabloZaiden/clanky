import type { LoopCtx } from "./context";
import type { Loop } from "../../types/loop";
import type { SeedPlanFilesOptions } from "./loop-types";
import { createTimestamp } from "../../types/events";
import { loadLoop, saveLoop } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { LoopEngine } from "../loop-engine";
import { writePlanningFiles } from "../planning-file-service";

export async function seedPlanFilesImpl(
  ctx: LoopCtx,
  loopId: string,
  options: SeedPlanFilesOptions,
): Promise<Loop> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    throw new Error(`Loop not found: ${loopId}`);
  }
  if (loop.state.status !== "planning" || !loop.state.planMode?.active) {
    throw new Error(`Loop is not in planning status: ${loop.state.status}`);
  }

  const startedAt = loop.state.startedAt ?? createTimestamp();
  loop.state.startedAt = startedAt;

  const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
  const git = GitService.withExecutor(executor);
  await ctx.validateMainCheckoutStart(loop, git);

  const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);
  const engine = new LoopEngine({
    loop,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
  });

  await engine.setupGitBranchForPlanAcceptance();

  const workingDirectory = engine.workingDirectory;
  const workingExecutor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, workingDirectory);
  await writePlanningFiles(workingExecutor, workingDirectory, options);

  loop.state.planMode = {
    ...loop.state.planMode,
    active: true,
    feedbackRounds: loop.state.planMode.feedbackRounds ?? 0,
    planContent: options.planContent,
    planningFolderCleared: loop.state.planMode.planningFolderCleared ?? false,
    isPlanReady: true,
  };
  loop.state.error = undefined;
  loop.state.completedAt = undefined;
  loop.state.session = undefined;

  await saveLoop(loop);

  ctx.emitter.emit({
    type: "loop.plan.ready",
    loopId,
    planContent: options.planContent,
    timestamp: createTimestamp(),
  });

  return loop;
}
