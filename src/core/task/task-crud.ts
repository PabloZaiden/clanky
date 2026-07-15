import type { TaskCtx } from "./context";
import { POST_APPROVAL_FULLY_AUTONOMOUS_EDITABLE_STATUSES, type Task, type TaskConfig, type TaskState } from "@/shared/task";
import type { CreateTaskOptions } from "./task-types";
import type { PullRequestDestinationResponse } from "@/contracts";
import { createTimestamp } from "@/shared/events";
import { createInitialState, DEFAULT_TASK_CONFIG } from "@/shared/task";
import { createTaskListSnapshot, saveTask, loadTask, listTasks, listTaskSummaries } from "../../persistence/tasks";
import { setLastCheapModel, setLastModel } from "../../persistence/preferences";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { log } from "../logger";
import { generateTaskName } from "../../utils/name-generator";
import { normalizeCommitScope } from "../../utils/commit-scope";
import { assertValidTransition, isActiveStatus } from "../task-state-machine";
import { normalizeBranchPrefix } from "../branch-name";
import { resolvePullRequestDestination } from "../pull-request-navigation";
import { resolveEffectiveCheapModel } from "../cheap-model";
import { isWorkspaceDeletionInProgress } from "../workspace-deletion";
import { getTaskWorkingDirectory, type GenerateTaskTitleOptions } from "./task-types";
import { handleFullyAutonomousCompletionImpl } from "./task-fully-autonomous";
import { TaskOperationError, TaskUpdateError, type TaskUpdateErrorCode } from "./task-errors";

export async function createTaskImpl(ctx: TaskCtx, options: CreateTaskOptions): Promise<Task> {
  const id = crypto.randomUUID();
  const now = createTimestamp();
  const name = options.name.trim();
  const fullyAutonomous = options.planMode ? (options.fullyAutonomous ?? DEFAULT_TASK_CONFIG.fullyAutonomous) : false;
  const autoAcceptPlan = options.planMode
    ? (options.autoAcceptPlan ?? DEFAULT_TASK_CONFIG.autoAcceptPlan)
    : false;

  if (!name) {
    throw new TaskOperationError("invalid_task_input", "Task name is required", {
      details: { field: "name" },
    });
  }
  if (isWorkspaceDeletionInProgress(options.workspaceId)) {
    throw new TaskOperationError(
      "operation_in_progress",
      "Workspace deletion is in progress",
      { details: { workspaceId: options.workspaceId } },
    );
  }

  log.debug("createTask - Input", {
    id,
    draft: options.draft,
    promptLength: options.prompt.length,
    promptPreview: options.prompt.slice(0, 50),
    workspaceId: options.workspaceId,
  });

  const config: TaskConfig = {
    id,
    name,
    directory: options.directory,
    prompt: options.prompt,
    issueNumber: options.issueNumber,
    createdAt: now,
    updatedAt: now,
    workspaceId: options.workspaceId,
    model: {
      providerID: options.modelProviderID,
      modelID: options.modelID,
      variant: options.modelVariant ?? "",
    },
    cheapModel: options.cheapModel ?? DEFAULT_TASK_CONFIG.cheapModel,
    maxIterations: options.maxIterations ?? DEFAULT_TASK_CONFIG.maxIterations,
    maxConsecutiveErrors: options.maxConsecutiveErrors ?? DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
    activityTimeoutSeconds:
      options.activityTimeoutSeconds !== undefined
        ? options.activityTimeoutSeconds
        : DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
    stopPattern: options.stopPattern ?? DEFAULT_TASK_CONFIG.stopPattern,
    git: {
      branchPrefix: normalizeBranchPrefix(options.gitBranchPrefix ?? DEFAULT_TASK_CONFIG.git.branchPrefix),
      commitScope: normalizeCommitScope(options.gitCommitScope ?? DEFAULT_TASK_CONFIG.git.commitScope) ?? "",
    },
    baseBranch: options.baseBranch,
    useWorktree: options.useWorktree ?? DEFAULT_TASK_CONFIG.useWorktree,
    clearPlanningFolder: options.clearPlanningFolder ?? DEFAULT_TASK_CONFIG.clearPlanningFolder,
    planMode: options.planMode,
    autoAcceptPlan,
    fullyAutonomous,
    mode: DEFAULT_TASK_CONFIG.mode,
  };

  const state = createInitialState(id);

  if (options.draft) {
    assertValidTransition(state.status, "draft", "createTask");
    state.status = "draft";
  } else if (options.planMode) {
    assertValidTransition(state.status, "planning", "createTask");
    state.status = "planning";
    state.planMode = {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    };
  }

  const task: Task = { config, state };

  await saveTask(task);

  ctx.emitter.emit({
    type: "task.created",
    taskId: id,
    config,
    timestamp: now,
  });

  return task;
}

export async function generateTaskTitleImpl(
  _ctx: TaskCtx,
  options: GenerateTaskTitleOptions,
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
    title: "Task Title Generation",
    directory: options.directory,
  });

  try {
    const helperModel = await resolveEffectiveCheapModel({
      workspaceId: options.workspaceId,
      directory: options.directory,
      model: options.model,
      cheapModel: options.cheapModel,
      operation: "task_title_generation",
    });
    const title = await generateTaskName({
      prompt: options.prompt,
      backend,
      sessionId: tempSession.id,
      model: helperModel,
    });
    log.info(`Generated task title: ${title}`);
    return title;
  } finally {
    try {
      await backend.abortSession(tempSession.id);
    } catch (cleanupError) {
      log.warn(`Failed to clean up temporary session: ${String(cleanupError)}`);
    }
  }
}

export async function getTaskImpl(ctx: TaskCtx, taskId: string): Promise<Task | null> {
  const engine = ctx.engines.get(taskId);
  if (engine) {
    return { config: engine.config, state: engine.state };
  }
  return loadTask(taskId);
}

export async function getAllTasksImpl(ctx: TaskCtx): Promise<Task[]> {
  const tasks = await listTasks();
  return tasks.map((task) => {
    const engine = ctx.engines.get(task.config.id);
    if (engine) {
      return { config: engine.config, state: engine.state };
    }
    return task;
  });
}

export async function getTaskSummariesImpl(ctx: TaskCtx): Promise<Task[]> {
  const tasks = await listTaskSummaries();
  return tasks.map((task) => {
    const engine = ctx.engines.get(task.config.id);
    if (engine) {
      return createTaskListSnapshot({ config: engine.config, state: engine.state });
    }
    return task;
  });
}

const ACTIVE_PLANNING_MUTABLE_CONFIG_KEYS = new Set<keyof Partial<Omit<TaskConfig, "id" | "createdAt">>>([
  "autoAcceptPlan",
  "fullyAutonomous",
  "isPrivate",
]);

const POST_APPROVAL_MUTABLE_CONFIG_KEYS = new Set<keyof Partial<Omit<TaskConfig, "id" | "createdAt">>>([
  "fullyAutonomous",
  "isPrivate",
]);

function createTaskUpdateError(
  message: string,
  code: TaskUpdateErrorCode,
): TaskUpdateError {
  return new TaskUpdateError(code, message);
}

function getDefinedUpdateKeys(
  updates: Partial<Omit<TaskConfig, "id" | "createdAt">>,
): Array<keyof Partial<Omit<TaskConfig, "id" | "createdAt">>> {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key as keyof Partial<Omit<TaskConfig, "id" | "createdAt">>);
}

function syncActivePlanningConfig(engine: { config: TaskConfig }, updatedConfig: TaskConfig): void {
  engine.config.autoAcceptPlan = updatedConfig.autoAcceptPlan;
  engine.config.fullyAutonomous = updatedConfig.fullyAutonomous;
  engine.config.isPrivate = updatedConfig.isPrivate;
  engine.config.updatedAt = updatedConfig.updatedAt;
}

function isPostApprovalFullyAutonomousMutable(
  config: TaskConfig,
  state: TaskState,
): boolean {
  return config.planMode
    && state.planMode?.active === false
    && POST_APPROVAL_FULLY_AUTONOMOUS_EDITABLE_STATUSES.has(state.status);
}

function assertAllowedPlanModeUpdateKeys(
  config: TaskConfig,
  state: TaskState,
  updates: Partial<Omit<TaskConfig, "id" | "createdAt">>,
): void {
  const definedKeys = getDefinedUpdateKeys(updates);
  if (definedKeys.length === 0) {
    return;
  }

  if (state.status === "planning") {
    const disallowedPlanningKeys = definedKeys.filter(
      (key) => !ACTIVE_PLANNING_MUTABLE_CONFIG_KEYS.has(key),
    );
    if (disallowedPlanningKeys.length > 0) {
      throw createTaskUpdateError(
        "Only auto-accept plan and fully autonomous task can be changed while plan mode is running.",
        "planning_update_restricted",
      );
    }
    return;
  }

  if (isPostApprovalFullyAutonomousMutable(config, state)) {
    const disallowedPostApprovalKeys = definedKeys.filter(
      (key) => !POST_APPROVAL_MUTABLE_CONFIG_KEYS.has(key),
    );
    if (disallowedPostApprovalKeys.length > 0) {
      throw createTaskUpdateError(
        "After plan approval, only the fully autonomous setting can be changed while execution is still in progress.",
        "plan_execution_update_restricted",
      );
    }
  }
}

function assertNameUpdateAllowed(
  state: TaskState,
  updates: Partial<Omit<TaskConfig, "id" | "createdAt">>,
): void {
  if (updates.name === undefined || state.status === "draft") {
    return;
  }

  throw createTaskUpdateError(
    "Task name can only be updated while the task is still a draft.",
    "task_rename_restricted",
  );
}

function syncPostApprovalFullyAutonomousPending(
  config: TaskConfig,
  state: TaskState,
): boolean {
  if (!isPostApprovalFullyAutonomousMutable(config, state)) {
    return false;
  }

  const nextPending = config.fullyAutonomous === true;
  const changed = state.fullyAutonomousPending !== nextPending;
  state.fullyAutonomousPending = nextPending;
  return changed && nextPending && state.status === "completed";
}

export async function updateTaskImpl(
  ctx: TaskCtx,
  taskId: string,
  updates: Partial<Omit<TaskConfig, "id" | "createdAt">>
): Promise<Task | null> {
  log.debug("updateTask - Input", {
    taskId,
    hasPromptUpdate: updates.prompt !== undefined,
    promptLength: updates.prompt?.length,
    promptPreview: updates.prompt?.slice(0, 50),
    issueNumber: updates.issueNumber,
  });

  const task = await loadTask(taskId);
  if (!task) {
    return null;
  }

  const engine = ctx.engines.get(taskId);
  const currentConfig = engine?.config ?? task.config;
  const currentState = engine?.state ?? task.state;

  assertNameUpdateAllowed(currentState, updates);
  assertAllowedPlanModeUpdateKeys(currentConfig, currentState, updates);

  if (engine) {
    const status = engine.state.status;
    if (
      status !== "planning"
      && !isPostApprovalFullyAutonomousMutable(currentConfig, engine.state)
      && (status === "waiting" || isActiveStatus(status))
    ) {
      throw createTaskUpdateError("Cannot update an active task. Stop it first.", "active_task_update_restricted");
    }
  }

  const pendingGitState = engine?.state.git;
  if (updates.baseBranch !== undefined && (task.state.git?.originalBranch || pendingGitState?.originalBranch)) {
    log.warn(`Rejected baseBranch update for task ${taskId} after git setup`);
    throw createTaskUpdateError("Base branch cannot be updated after git setup.", "base_branch_immutable");
  }

  if (
    updates.useWorktree !== undefined &&
    updates.useWorktree !== currentConfig.useWorktree &&
    (task.state.git?.originalBranch || pendingGitState?.originalBranch)
  ) {
    log.warn(`Rejected useWorktree update for task ${taskId} after git setup`);
    throw createTaskUpdateError("Use Worktree cannot be updated after git setup.", "use_worktree_immutable");
  }

  if (updates.baseBranch !== undefined && task.state.status === "draft") {
    log.info(`Updating baseBranch for draft task ${taskId}`);
  }

  const updatedConfig: TaskConfig = {
    ...currentConfig,
    ...updates,
    cheapModel: updates.cheapModel ?? currentConfig.cheapModel ?? DEFAULT_TASK_CONFIG.cheapModel,
    git: updates.git
      ? {
          ...currentConfig.git,
          ...updates.git,
          branchPrefix: normalizeBranchPrefix(updates.git.branchPrefix ?? currentConfig.git.branchPrefix),
        }
      : currentConfig.git,
    updatedAt: createTimestamp(),
  };

  if (!updatedConfig.planMode) {
    updatedConfig.autoAcceptPlan = false;
    updatedConfig.fullyAutonomous = false;
  }

  const shouldTriggerCompletedAutonomy = syncPostApprovalFullyAutonomousPending(updatedConfig, currentState);

  const updatedTask: Task = { config: updatedConfig, state: currentState };
  await saveTask(updatedTask);
  if (engine) {
    syncActivePlanningConfig(engine, updatedConfig);
  }
  if (shouldTriggerCompletedAutonomy) {
    await handleFullyAutonomousCompletionImpl(ctx, taskId);
  }

  return updatedTask;
}

export async function getPullRequestDestinationImpl(
  ctx: TaskCtx,
  taskId: string
): Promise<PullRequestDestinationResponse | null> {
  const task = await getTaskImpl(ctx, taskId);
  if (!task) {
    return null;
  }

  if (task.state.status !== "pushed" || task.state.reviewMode?.addressable !== true) {
    return {
      enabled: false,
      destinationType: "disabled",
      disabledReason: "Pull request navigation is only available for pushed tasks awaiting feedback.",
    };
  }

  const workingDirectory = getTaskWorkingDirectory(task);
  if (!workingDirectory) {
    return {
      enabled: false,
      destinationType: "disabled",
      disabledReason: "Task is configured to use a worktree, but no worktree path is available.",
    };
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workingDirectory);
    const git = GitService.withExecutor(executor);
    return await resolvePullRequestDestination(task, workingDirectory, executor, git);
  } catch (error) {
    log.error("Failed to resolve pull request destination", {
      taskId,
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
  _ctx: TaskCtx,
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
  _ctx: TaskCtx,
  selection: NonNullable<TaskConfig["cheapModel"]>,
): Promise<void> {
  try {
    await setLastCheapModel(selection);
  } catch (error) {
    log.warn(`Failed to save last cheap model: ${String(error)}`);
  }
}

export function isRunningImpl(ctx: TaskCtx, taskId: string): boolean {
  return ctx.engines.has(taskId);
}

export function getRunningTaskStateImpl(ctx: TaskCtx, taskId: string): TaskState | null {
  const engine = ctx.engines.get(taskId);
  return engine?.state ?? null;
}
