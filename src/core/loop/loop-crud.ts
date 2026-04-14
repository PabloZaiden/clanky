import type { LoopCtx } from "./context";
import type { Loop, LoopConfig, LoopState } from "../../types/loop";
import type { CreateLoopOptions } from "./loop-types";
import type { PullRequestDestinationResponse } from "../../types/api";
import { createTimestamp } from "../../types/events";
import { createInitialState, DEFAULT_LOOP_CONFIG } from "../../types/loop";
import { saveLoop, loadLoop, listLoops } from "../../persistence/loops";
import { setLastCheapModel, setLastModel } from "../../persistence/preferences";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { generateLoopName } from "../../utils/name-generator";
import { normalizeCommitScope } from "../../utils/commit-scope";
import { assertValidTransition } from "../loop-state-machine";
import { normalizeBranchPrefix } from "../branch-name";
import { resolvePullRequestDestination } from "../pull-request-navigation";
import { resolveEffectiveCheapModel } from "../cheap-model";
import { getLoopWorkingDirectory, type GenerateLoopTitleOptions } from "./loop-types";

export async function createLoopImpl(ctx: LoopCtx, options: CreateLoopOptions): Promise<Loop> {
  const id = crypto.randomUUID();
  const now = createTimestamp();
  const name = options.name.trim();
  const fullyAutonomous = options.planMode ? (options.fullyAutonomous ?? DEFAULT_LOOP_CONFIG.fullyAutonomous) : false;
  const autoAcceptPlan = options.planMode
    ? (fullyAutonomous ? true : (options.autoAcceptPlan ?? DEFAULT_LOOP_CONFIG.autoAcceptPlan))
    : false;

  if (!name) {
    throw new Error("Loop name is required");
  }

  log.debug("createLoop - Input", {
    id,
    draft: options.draft,
    promptLength: options.prompt.length,
    promptPreview: options.prompt.slice(0, 50),
    workspaceId: options.workspaceId,
  });

  const config: LoopConfig = {
    id,
    name,
    directory: options.directory,
    prompt: options.prompt,
    createdAt: now,
    updatedAt: now,
    workspaceId: options.workspaceId,
    model: {
      providerID: options.modelProviderID,
      modelID: options.modelID,
      variant: options.modelVariant ?? "",
    },
    cheapModel: options.cheapModel ?? DEFAULT_LOOP_CONFIG.cheapModel,
    maxIterations: options.maxIterations ?? DEFAULT_LOOP_CONFIG.maxIterations,
    maxConsecutiveErrors: options.maxConsecutiveErrors ?? DEFAULT_LOOP_CONFIG.maxConsecutiveErrors,
    activityTimeoutSeconds:
      options.activityTimeoutSeconds !== undefined
        ? options.activityTimeoutSeconds
        : DEFAULT_LOOP_CONFIG.activityTimeoutSeconds,
    stopPattern: options.stopPattern ?? DEFAULT_LOOP_CONFIG.stopPattern,
    git: {
      branchPrefix: normalizeBranchPrefix(options.gitBranchPrefix ?? DEFAULT_LOOP_CONFIG.git.branchPrefix),
      commitScope: normalizeCommitScope(options.gitCommitScope ?? DEFAULT_LOOP_CONFIG.git.commitScope) ?? "",
    },
    baseBranch: options.baseBranch,
    useWorktree: options.useWorktree ?? DEFAULT_LOOP_CONFIG.useWorktree,
    clearPlanningFolder: options.clearPlanningFolder ?? DEFAULT_LOOP_CONFIG.clearPlanningFolder,
    planMode: options.planMode,
    autoAcceptPlan,
    fullyAutonomous,
    mode: DEFAULT_LOOP_CONFIG.mode,
  };

  const state = createInitialState(id);

  if (options.draft) {
    assertValidTransition(state.status, "draft", "createLoop");
    state.status = "draft";
  } else if (options.planMode) {
    assertValidTransition(state.status, "planning", "createLoop");
    state.status = "planning";
    state.planMode = {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    };
  }

  const loop: Loop = { config, state };

  await saveLoop(loop);

  ctx.emitter.emit({
    type: "loop.created",
    loopId: id,
    config,
    timestamp: now,
  });

  return loop;
}

export async function generateLoopTitleImpl(
  _ctx: LoopCtx,
  options: GenerateLoopTitleOptions,
): Promise<string> {
  let backend = backendManager.getInitializedBackend(options.workspaceId);
  if (
    !backend
    || !backendManager.isWorkspaceConnected(options.workspaceId)
    || backend.getDirectory() !== options.directory
  ) {
    await backendManager.connect(options.workspaceId, options.directory);
    backend = backendManager.getBackend(options.workspaceId);
  }
  const tempSession = await backend.createSession({
    title: "Loop Title Generation",
    directory: options.directory,
  });

  try {
    const helperModel = await resolveEffectiveCheapModel({
      workspaceId: options.workspaceId,
      directory: options.directory,
      model: options.model,
      cheapModel: options.cheapModel,
      operation: "loop_title_generation",
    });
    const title = await generateLoopName({
      prompt: options.prompt,
      backend,
      sessionId: tempSession.id,
      model: helperModel,
    });
    log.info(`Generated loop title: ${title}`);
    return title;
  } finally {
    try {
      await backend.abortSession(tempSession.id);
    } catch (cleanupError) {
      log.warn(`Failed to clean up temporary session: ${String(cleanupError)}`);
    }
  }
}

export async function getLoopImpl(ctx: LoopCtx, loopId: string): Promise<Loop | null> {
  const engine = ctx.engines.get(loopId);
  if (engine) {
    return { config: engine.config, state: engine.state };
  }
  return loadLoop(loopId);
}

export async function getAllLoopsImpl(ctx: LoopCtx): Promise<Loop[]> {
  const loops = await listLoops();
  return loops.map((loop) => {
    const engine = ctx.engines.get(loop.config.id);
    if (engine) {
      return { config: engine.config, state: engine.state };
    }
    return loop;
  });
}

export async function updateLoopImpl(
  ctx: LoopCtx,
  loopId: string,
  updates: Partial<Omit<LoopConfig, "id" | "createdAt">>
): Promise<Loop | null> {
  log.debug("updateLoop - Input", {
    loopId,
    hasPromptUpdate: updates.prompt !== undefined,
    promptLength: updates.prompt?.length,
    promptPreview: updates.prompt?.slice(0, 50),
  });

  const loop = await loadLoop(loopId);
  if (!loop) {
    return null;
  }

  const engine = ctx.engines.get(loopId);
  if (engine) {
    const status = engine.state.status;
    if (status === "running" || status === "starting") {
      throw new Error("Cannot update a running loop. Stop it first.");
    }
  }

  const pendingGitState = ctx.engines.get(loopId)?.state.git;
  if (updates.baseBranch !== undefined && (loop.state.git?.originalBranch || pendingGitState?.originalBranch)) {
    log.warn(`Rejected baseBranch update for loop ${loopId} after git setup`);
    const error = new Error("Base branch cannot be updated after git setup.") as Error & {
      code: string;
      status: number;
    };
    error.code = "BASE_BRANCH_IMMUTABLE";
    error.status = 409;
    throw error;
  }

  if (
    updates.useWorktree !== undefined &&
    updates.useWorktree !== loop.config.useWorktree &&
    (loop.state.git?.originalBranch || pendingGitState?.originalBranch)
  ) {
    log.warn(`Rejected useWorktree update for loop ${loopId} after git setup`);
    const error = new Error("Use Worktree cannot be updated after git setup.") as Error & {
      code: string;
      status: number;
    };
    error.code = "USE_WORKTREE_IMMUTABLE";
    error.status = 409;
    throw error;
  }

  if (updates.baseBranch !== undefined && loop.state.status === "draft") {
    log.info(`Updating baseBranch for draft loop ${loopId}`);
  }

  const updatedConfig: LoopConfig = {
    ...loop.config,
    ...updates,
    cheapModel: updates.cheapModel ?? loop.config.cheapModel ?? DEFAULT_LOOP_CONFIG.cheapModel,
    git: updates.git
      ? {
          ...loop.config.git,
          ...updates.git,
          branchPrefix: normalizeBranchPrefix(updates.git.branchPrefix ?? loop.config.git.branchPrefix),
        }
      : loop.config.git,
    updatedAt: createTimestamp(),
  };

  if (!updatedConfig.planMode) {
    updatedConfig.autoAcceptPlan = false;
    updatedConfig.fullyAutonomous = false;
  } else if (updatedConfig.fullyAutonomous) {
    updatedConfig.autoAcceptPlan = true;
  }

  const updatedLoop: Loop = { config: updatedConfig, state: loop.state };
  await saveLoop(updatedLoop);

  return updatedLoop;
}

export async function getPullRequestDestinationImpl(
  ctx: LoopCtx,
  loopId: string
): Promise<PullRequestDestinationResponse | null> {
  const loop = await getLoopImpl(ctx, loopId);
  if (!loop) {
    return null;
  }

  if (loop.state.status !== "pushed" || loop.state.reviewMode?.addressable !== true) {
    return {
      enabled: false,
      destinationType: "disabled",
      disabledReason: "Pull request navigation is only available for pushed loops awaiting feedback.",
    };
  }

  const workingDirectory = getLoopWorkingDirectory(loop);
  if (!workingDirectory) {
    return {
      enabled: false,
      destinationType: "disabled",
      disabledReason: "Loop is configured to use a worktree, but no worktree path is available.",
    };
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, workingDirectory);
    const git = GitService.withExecutor(executor);
    return await resolvePullRequestDestination(loop, workingDirectory, executor, git);
  } catch (error) {
    log.error("Failed to resolve pull request destination", {
      loopId,
      error: String(error),
    });
    return {
      enabled: false,
      destinationType: "disabled",
      disabledReason: "Pull request navigation is temporarily unavailable.",
    };
  }
}

export async function saveLastUsedModelImpl(
  _ctx: LoopCtx,
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  }
): Promise<void> {
  try {
    await setLastModel(model);
  } catch (error) {
    log.warn(`Failed to save last model: ${String(error)}`);
  }
}

export async function saveLastUsedCheapModelImpl(
  _ctx: LoopCtx,
  selection: NonNullable<LoopConfig["cheapModel"]>,
): Promise<void> {
  try {
    await setLastCheapModel(selection);
  } catch (error) {
    log.warn(`Failed to save last cheap model: ${String(error)}`);
  }
}

export function isRunningImpl(ctx: LoopCtx, loopId: string): boolean {
  return ctx.engines.has(loopId);
}

export function getRunningLoopStateImpl(ctx: LoopCtx, loopId: string): LoopState | null {
  const engine = ctx.engines.get(loopId);
  return engine?.state ?? null;
}
