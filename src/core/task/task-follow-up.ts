import type { TaskCtx } from "./context";
import type { Task, TaskStatus, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { SendFollowUpOptions, SendFollowUpResult } from "./task-types";
import { loadTask } from "../../persistence/tasks";
import { updateTaskState } from "../../persistence/tasks";
import { TaskEngine } from "../task-engine";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { createTimestamp } from "@/shared/events";
import { log } from "../logger";
import { assertValidTransition } from "../task-state-machine";
import { canReuseExistingBranch, jumpstartTaskFromEngine } from "./task-jumpstart";
import { getTaskWorkingDirectory } from "./task-types";
import { startStatePersistenceImpl } from "./task-state-persistence";

export async function sendFollowUpImpl(
  ctx: TaskCtx,
  taskId: string,
  options: SendFollowUpOptions,
): Promise<SendFollowUpResult> {
  const message = options.message.trim();
  if (message === "") {
    return { success: false, error: "Follow-up message cannot be empty" };
  }
  if (options.model && (!options.model.providerID || !options.model.modelID)) {
    return { success: false, error: "Invalid model config: providerID and modelID are required" };
  }

  const task = await loadTask(taskId);
  if (!task) {
    return { success: false, error: "Task not found" };
  }

  const promptMode = options.promptMode ?? "task_context";
  if (promptMode === "plain_chat") {
    return startPlainChatFollowUp(ctx, task, {
      message,
      model: options.model,
      attachments: options.attachments,
    });
  }

  if (task.state.status === "pushed" || task.state.status === "accepted_local") {
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

async function startPlainChatFollowUp(
  ctx: TaskCtx,
  task: Task,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): Promise<SendFollowUpResult> {
  const taskId = task.config.id;
  const activeEngine = ctx.engines.get(taskId);
  if (activeEngine && isActiveSingleTurnStatus(activeEngine.state.status)) {
    return { success: false, error: `Task is already active (status: ${activeEngine.state.status})` };
  }

  if (task.state.planMode?.active || task.state.status === "planning") {
    return { success: false, error: "Planning tasks must receive feedback through plan feedback" };
  }

  if (task.state.status !== "completed" && task.state.status !== "pushed") {
    return { success: false, error: `Task cannot accept a plain chat follow-up from status: ${task.state.status}` };
  }

  if (!(await canReuseExistingBranch(task))) {
    return { success: false, error: "Cannot resume conversation: the task branch or worktree is no longer available" };
  }

  const workingDirectory = getTaskWorkingDirectory(task);
  if (!workingDirectory) {
    return { success: false, error: "Task is configured to use a worktree, but no worktree path is available - cannot resume conversation" };
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
    onPersistState: async (state) => {
      await updateTaskState(taskId, state);
    },
    skipGitSetup: true,
  });

  const previousSessionId = engine.state.session?.id;
  try {
    await engine.reconnectSession();
  } catch (error) {
    if (ctx.engines.get(taskId) === engine) {
      ctx.engines.delete(taskId);
    }
    return { success: false, error: `Failed to reconnect task session: ${String(error)}` };
  }
  if (previousSessionId && engine.state.session?.id && engine.state.session.id !== previousSessionId) {
    log.warn("Previous task session expired; plain chat follow-up is starting with a fresh session", {
      taskId,
      previousSessionId,
      newSessionId: engine.state.session.id,
    });
  }

  preparePlainChatState(engine, options);
  await updateTaskState(taskId, engine.state);
  ctx.engines.set(taskId, engine);
  startStatePersistenceImpl(ctx, taskId);

  engine.runSingleTurn().catch(async (error) => {
    log.error(`Plain chat follow-up failed for task ${taskId}: ${String(error)}`);
    if (engine.state.status === "running" || engine.state.status === "starting") {
      assertValidTransition(engine.state.status, "failed", "plainChatFollowUp");
      engine.state.status = "failed";
      engine.state.completedAt = createTimestamp();
      engine.state.error = {
        message: String(error),
        iteration: engine.state.currentIteration,
        timestamp: createTimestamp(),
      };
      await updateTaskState(taskId, engine.state);
    }
  });

  return { success: true };
}

function preparePlainChatState(
  engine: TaskEngine,
  options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
): void {
  const state = engine.state;
  if (state.status === "failed" || state.status === "max_iterations") {
    assertValidTransition(state.status, "stopped", "plainChatFollowUp");
    state.status = "stopped";
  }

  assertValidTransition(state.status, "starting", "plainChatFollowUp");
  state.status = "starting";
  assertValidTransition(state.status, "running", "plainChatFollowUp");
  state.status = "running";
  state.startedAt ??= createTimestamp();
  state.completedAt = undefined;
  state.error = undefined;
  state.syncState = undefined;
  engine.setPendingPrompt(options.message, options.attachments, "plain_chat");
  if (options.model) {
    engine.setPendingModel(options.model);
  }
}

function isActiveSingleTurnStatus(status: TaskStatus): boolean {
  return status === "starting" || status === "running" || status === "planning" || status === "resolving_conflicts";
}
