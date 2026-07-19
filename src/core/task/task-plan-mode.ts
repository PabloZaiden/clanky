import type { TaskCtx } from "./context";
import type { AcceptPlanOptions, AcceptPlanResult } from "./task-types";
import { createTimestamp } from "@/shared/events";
import { updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { sshSessionManager } from "../ssh-session-manager";
import { log } from "@pablozaiden/webapp/server";
import { assertValidTransition } from "../task-state-machine";
import { syncBaseBranchBeforeExecution } from "./task-git-push-helpers";
import type { TaskState } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { TaskOperationError } from "./task-errors";

export async function sendPlanFeedbackImpl(
  ctx: TaskCtx,
  taskId: string,
  feedback: string,
  attachments: MessageImageAttachment[] = [],
): Promise<void> {
  const engine = ctx.engines.get(taskId) ?? await ctx.recoverPlanningEngine(taskId);

  if (engine.state.status !== "planning") {
    throw new TaskOperationError(
      "task_not_planning",
      `Task is not in planning status: ${engine.state.status}`,
      { details: { taskId, status: engine.state.status } },
    );
  }

  if (engine.state.planMode) {
    engine.state.planMode.feedbackRounds += 1;
    engine.state.planMode.isPlanReady = false;
  }

  await updateTaskState(taskId, engine.state);

  ctx.emitter.emit({
    type: "task.plan.feedback",
    taskId,
    round: engine.state.planMode?.feedbackRounds ?? 0,
    timestamp: createTimestamp(),
  });

  await engine.injectPlanFeedback(feedback, attachments);
}

export async function acceptPlanImpl(
  ctx: TaskCtx,
  taskId: string,
  options: AcceptPlanOptions = {}
): Promise<AcceptPlanResult> {
  const engine = ctx.engines.get(taskId) ?? await ctx.recoverPlanningEngine(taskId);
  const mode = options.mode ?? "start_task";

  if (engine.state.status !== "planning") {
    throw new TaskOperationError(
      "task_not_planning",
      `Task is not in planning status: ${engine.state.status}`,
      { details: { taskId, status: engine.state.status } },
    );
  }

  if (!engine.state.planMode?.isPlanReady) {
    throw new TaskOperationError(
      "plan_not_ready",
      "Plan is not ready yet. Wait for the AI to finish generating the plan.",
      { details: { taskId } },
    );
  }

  await engine.waitForTaskIdle();

  const planSessionId = engine.state.session?.id;
  const planServerUrl = engine.state.session?.serverUrl;
  const now = createTimestamp();

  const targetStatus = mode === "open_ssh" ? "completed" : "starting";
  assertValidTransition(engine.state.status, targetStatus, "acceptPlan");
  const updatedState: Partial<TaskState> = {
    status: targetStatus,
    startedAt: engine.state.startedAt ?? now,
    completedAt: mode === "open_ssh" ? now : engine.state.completedAt,
    pendingPrompt: mode === "open_ssh" ? undefined : engine.state.pendingPrompt,
    fullyAutonomousPending: engine.config.fullyAutonomous === true && mode === "start_task",
    planMode: {
      ...engine.state.planMode,
      active: false,
      planSessionId,
      planServerUrl,
      feedbackRounds: engine.state.planMode?.feedbackRounds ?? 0,
      planningFolderCleared: engine.state.planMode?.planningFolderCleared ?? false,
    },
  };

  Object.assign(engine.state, updatedState);
  await updateTaskState(taskId, engine.state);

  const executionPrompt = options.executionPrompt ?? buildAcceptedPlanExecutionPrompt();
  const executionPromptMode = options.executionPromptMode;

  ctx.emitter.emit({
    type: "task.plan.accepted",
    taskId,
    timestamp: now,
  });

  if (mode === "open_ssh") {
    ctx.emitter.emit({
      type: "task.ssh_handoff",
      taskId,
      totalIterations: engine.state.currentIteration,
      timestamp: now,
    });

    const sshSession = await sshSessionManager.getOrCreateTaskSession(taskId);
    return {
      mode,
      sshSession,
    };
  }

  const executor = await backendManager.getCommandExecutorAsync(engine.config.workspaceId, engine.config.directory);
  const git = GitService.withExecutor(executor);
  const syncResult = await syncBaseBranchBeforeExecution(
    ctx,
    taskId,
    { config: engine.config, state: engine.state },
    git,
    async () => {
      await beginAcceptedPlanExecution(ctx, taskId, executionPrompt, executionPromptMode);
    },
    engine,
  );

  if (!syncResult.success) {
    const errorMsg = syncResult.error.message;
    await failAcceptedPlanExecutionStart(taskId, engine, errorMsg);
    throw syncResult.error;
  }

  if (syncResult.syncStatus !== "conflicts_being_resolved") {
    await beginAcceptedPlanExecution(ctx, taskId, executionPrompt, executionPromptMode);
  }

  return {
    mode,
  };
}

export function buildAcceptedPlanExecutionPrompt(): string {
  return `The plan has been accepted. Now execute all tasks in the plan.

Follow the standard task execution flow:
- Read the plan in .clanky-planning/plan.md
- Pick up the most important task to continue with
- **IMPORTANT — Incremental progress tracking**: After completing each individual task, immediately update .clanky-planning/status.md to mark it as completed and note any relevant findings. Do not wait until the end — update after every task so progress is preserved if the iteration is interrupted.
- **IMPORTANT — Pre-compaction persistence**: Before ending your response, you MUST also update .clanky-planning/status.md with the current task and its state, updated status of all tasks, any new learnings or discoveries, and what the next steps should be. This ensures progress is preserved even if the conversation context is compacted or summarized between iterations.
- If you complete all tasks in the plan, end your response with:

<promise>COMPLETE</promise>`;
}

async function beginAcceptedPlanExecution(
  ctx: TaskCtx,
  taskId: string,
  executionPrompt: string,
  executionPromptMode?: "task_context" | "plain_chat",
): Promise<void> {
  const engine = ctx.engines.get(taskId);
  if (!engine) {
    throw new TaskOperationError(
      "task_not_running",
      "Task plan mode is not running",
      { details: { taskId } },
    );
  }

  await engine.waitForTaskIdle();

  if (engine.state.status === "completed") {
    assertValidTransition(engine.state.status, "starting", "beginAcceptedPlanExecution");
    engine.state.status = "starting";
    engine.state.completedAt = undefined;
    await updateTaskState(taskId, engine.state);
  }

  assertValidTransition(engine.state.status, "running", "beginAcceptedPlanExecution");
  engine.state.status = "running";
  engine.state.syncState = undefined;
  engine.state.completedAt = undefined;
  await updateTaskState(taskId, engine.state);

  ctx.emitter.emit({
    type: "task.started",
    taskId,
    iteration: 0,
    timestamp: createTimestamp(),
  });

  engine.setPendingPrompt(executionPrompt, undefined, executionPromptMode);

  engine.continueExecution().catch((error) => {
    log.error(`Task ${taskId} execution after plan acceptance failed:`, String(error));
  });
}

async function failAcceptedPlanExecutionStart(
  taskId: string,
  engine: { state: TaskState },
  errorMsg: string,
): Promise<void> {
  assertValidTransition(engine.state.status, "failed", "acceptPlan");
  engine.state.status = "failed";
  engine.state.fullyAutonomousPending = false;
  engine.state.syncState = undefined;
  engine.state.completedAt = createTimestamp();
  engine.state.error = {
    message: errorMsg,
    iteration: engine.state.currentIteration,
    timestamp: createTimestamp(),
  };
  await updateTaskState(taskId, engine.state);
}

export async function discardPlanImpl(ctx: TaskCtx, taskId: string): Promise<boolean> {
  log.debug(`[TaskManager] discardPlan: Starting for task ${taskId}, engine exists: ${ctx.engines.has(taskId)}`);

  if (ctx.engines.has(taskId)) {
    log.debug(`[TaskManager] discardPlan: Stopping engine for task ${taskId}`);
    await ctx.stopTask(taskId, "Plan discarded");
    log.debug(`[TaskManager] discardPlan: Engine stopped for task ${taskId}`);
  }

  ctx.emitter.emit({
    type: "task.plan.discarded",
    taskId,
    timestamp: createTimestamp(),
  });

  log.debug(`[TaskManager] discardPlan: Calling deleteTask for ${taskId}`);
  const result = await ctx.deleteTask(taskId);
  log.debug(`[TaskManager] discardPlan: deleteTask returned ${result} for ${taskId}`);
  return result;
}
