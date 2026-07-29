import type { TaskCtx } from "./context";
import type { Task, TaskStatus, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { SendFollowUpOptions, SendFollowUpResult } from "./task-types";
import {
  loadTask,
  updateTaskOperationalState,
  updateTaskState,
} from "../../persistence/tasks";
import { TaskEngine } from "../task-engine";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { createTimestamp } from "@/shared/events";
import { log } from "@pablozaiden/webapp/server";
import { assertValidTransition } from "../task-state-machine";
import { canReuseExistingBranch, jumpstartTaskFromEngine } from "./task-jumpstart";
import { getTaskWorkingDirectory } from "./task-types";
import { startStatePersistenceImpl } from "./task-state-persistence";
import { taskFailure } from "./task-errors";

export async function sendFollowUpImpl(
  ctx: TaskCtx,
  taskId: string,
  options: SendFollowUpOptions,
): Promise<SendFollowUpResult> {
  const message = options.message.trim();
  if (message === "") {
    return taskFailure("invalid_task_input", "Follow-up message cannot be empty");
  }
  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return taskFailure(
      "invalid_model_config",
      "Invalid model config: providerID and modelID are required",
    );
  }

  const task = await loadTask(taskId);
  if (!task) {
    return taskFailure("task_not_found", "Task not found", { details: { taskId } });
  }

  // Terminal task follow-ups are user-authored turns that resume the task
  // loop. Review feedback remains a separate workflow for accepted-local
  // tasks, so the client never chooses prompt intent.
  if (task.state.status === "completed" || task.state.status === "pushed") {
    return startTaskLoopFollowUp(ctx, task, {
      message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  if (task.state.status === "accepted_local") {
    return ctx.startFeedbackCycle(taskId, {
      prompt: message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  if (task.state.status === "deleted") {
    return jumpstartTaskFromEngine(ctx, taskId, {
      message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  return jumpstartTaskFromEngine(ctx, taskId, {
    message,
    model: options.model,
    attachments: options.attachments,
  });
}

async function startTaskLoopFollowUp(
  ctx: TaskCtx,
  task: Task,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): Promise<SendFollowUpResult> {
  const taskId = task.config.id;
  const activeEngine = ctx.engines.get(taskId);
  if (activeEngine && isActiveSingleTurnStatus(activeEngine.state.status)) {
    return taskFailure(
      "task_already_running",
      `Task is already active (status: ${activeEngine.state.status})`,
      { details: { taskId, status: activeEngine.state.status } },
    );
  }

  if (task.state.planMode?.active || task.state.status === "planning") {
    return taskFailure(
      "task_not_planning",
      "Planning tasks must receive feedback through plan feedback",
      { details: { taskId, status: task.state.status } },
    );
  }

  if (task.state.status !== "completed" && task.state.status !== "pushed") {
    return taskFailure(
      "invalid_task_state",
      `Task cannot accept an execution follow-up from status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  if (!(await canReuseExistingBranch(task))) {
    return taskFailure(
      "task_branch_missing",
      "Cannot resume conversation: the task branch or worktree is no longer available",
      { details: { taskId } },
    );
  }

  const workingDirectory = getTaskWorkingDirectory(task);
  if (!workingDirectory) {
    return taskFailure(
      "task_worktree_missing",
      "Task is configured to use a worktree, but no worktree path is available - cannot resume conversation",
      { details: { taskId } },
    );
  }

  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workingDirectory);
  const git = GitService.withExecutor(executor);
  await ctx.ensureTaskBranchCheckedOut(task, git, workingDirectory);

  if (activeEngine) {
    ctx.engines.delete(taskId);
  }

  const engine = new TaskEngine({
    task,
    backend: backendManager.getTaskBackend(taskId, task.config.workspaceId),
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state, options) => {
      await updateTaskState(taskId, state, options);
    },
    skipGitSetup: true,
    executionPolicy: "task_loop",
  });

  const previousSessionId = task.state.session?.id;
  try {
    await engine.reconnectSession();
  } catch (error) {
    return taskFailure(
      "task_session_reconnect_failed",
      "Failed to reconnect task session",
      { cause: error, details: { taskId } },
    );
  }
  if (previousSessionId && engine.state.session?.id && engine.state.session.id !== previousSessionId) {
    log.warn("Previous task session expired; task follow-up is starting with a fresh session", {
      taskId,
      previousSessionId,
      newSessionId: engine.state.session.id,
    });
  }

  prepareTaskLoopFollowUpState(engine, options);
  await updateTaskOperationalState(taskId, engine.state);
  ctx.engines.set(taskId, engine);
  startStatePersistenceImpl(ctx, taskId);

  engine.continueExecution().catch(async (error) => {
    log.error(`Task follow-up failed for task ${taskId}: ${String(error)}`);
    if (engine.state.status === "running" || engine.state.status === "starting") {
      assertValidTransition(engine.state.status, "failed", "taskLoopFollowUp");
      engine.state.status = "failed";
      engine.state.completedAt = createTimestamp();
      engine.state.error = {
        message: String(error),
        iteration: engine.state.currentIteration,
        timestamp: createTimestamp(),
      };
      await updateTaskOperationalState(taskId, engine.state);
    }
  });

  return { success: true };
}

function prepareTaskLoopFollowUpState(
  engine: TaskEngine,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): void {
  const state = engine.state;
  if (state.status === "completed" || state.status === "pushed") {
    assertValidTransition(state.status, "starting", "taskLoopFollowUp");
    state.status = "starting";
  }

  assertValidTransition(state.status, "running", "taskLoopFollowUp");
  state.status = "running";
  state.startedAt ??= createTimestamp();
  state.completedAt = undefined;
  state.error = undefined;
  state.syncState = undefined;
  engine.setPendingPrompt(options.message, options.attachments, "direct_user");
  if (options.model) {
    engine.setPendingModel(options.model);
  }
}

function isActiveSingleTurnStatus(status: TaskStatus): boolean {
  return status === "starting" || status === "running" || status === "planning" || status === "resolving_conflicts";
}
