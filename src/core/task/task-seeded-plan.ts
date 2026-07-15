import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import type { SeedPlanFilesOptions } from "./task-types";
import { createTimestamp } from "@/shared/events";
import { loadTask, saveTask } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { TaskEngine } from "../task-engine";
import { writePlanningFiles } from "../planning-file-service";
import { TaskOperationError } from "./task-errors";

export async function seedPlanFilesImpl(
  ctx: TaskCtx,
  taskId: string,
  options: SeedPlanFilesOptions,
): Promise<Task> {
  const task = await loadTask(taskId);
  if (!task) {
    throw new TaskOperationError("task_not_found", "Task not found", {
      details: { taskId },
    });
  }
  if (task.state.status !== "planning" || !task.state.planMode?.active) {
    throw new TaskOperationError(
      "task_not_planning",
      `Task is not in planning status: ${task.state.status}`,
      { details: { taskId, status: task.state.status } },
    );
  }

  const startedAt = task.state.startedAt ?? createTimestamp();
  task.state.startedAt = startedAt;

  const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, task.config.directory);
  const git = GitService.withExecutor(executor);
  await ctx.validateMainCheckoutStart(task, git);

  const backend = backendManager.getTaskBackend(taskId, task.config.workspaceId);
  const engine = new TaskEngine({
    task,
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
  });

  await engine.setupGitBranchForPlanAcceptance();

  const workingDirectory = engine.workingDirectory;
  const workingExecutor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workingDirectory);
  await writePlanningFiles(workingExecutor, workingDirectory, options);

  task.state.planMode = {
    ...task.state.planMode,
    active: true,
    feedbackRounds: task.state.planMode.feedbackRounds ?? 0,
    planContent: options.planContent,
    planningFolderCleared: task.state.planMode.planningFolderCleared ?? false,
    isPlanReady: true,
  };
  task.state.error = undefined;
  task.state.completedAt = undefined;
  task.state.session = undefined;

  await saveTask(task);

  ctx.emitter.emit({
    type: "task.plan.ready",
    taskId,
    planContent: options.planContent,
    timestamp: createTimestamp(),
  });

  return task;
}
