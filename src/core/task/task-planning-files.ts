import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import type { CommandExecutor } from "../command-executor";
import { updateTaskOperationalState } from "../../persistence/tasks";
import { log } from "@pablozaiden/webapp/server";
import {
  clearPlanningDirectory,
  ensurePlanningDirectory,
} from "../planning-directory";
import { ManagedPathService } from "../managed-path-service";

export async function clearPlanningFilesImpl(
  _ctx: TaskCtx,
  taskId: string,
  task: Task,
  executor: CommandExecutor,
  worktreePath: string
): Promise<void> {
  const planningDir = await ensurePlanningDirectory(executor, worktreePath);
  const managedPaths = new ManagedPathService(executor.pathStyle);

  if (task.config.clearPlanningFolder && !task.state.planMode?.planningFolderCleared) {
    try {
      await clearPlanningDirectory(
        executor,
        planningDir,
        new Set([".gitkeep"]),
      );

      if (task.state.planMode) {
        task.state.planMode.planningFolderCleared = true;
        await updateTaskOperationalState(taskId, task.state);
      }
    } catch (error) {
      log.warn(`Failed to clear .clanky-planning folder: ${String(error)}`);
    }
  }

  const planFilePath = managedPaths.getPlanFilePath(worktreePath);
  try {
    const planFileExists = await executor.fileExists(planFilePath);
    if (
      planFileExists
      && !(await executor.deletePath(planFilePath, { kind: "file" }))
    ) {
      throw new Error(`Failed to delete ${planFilePath}`);
    }
    if (planFileExists) {
      log.debug("Cleared stale plan.md file before starting plan mode");
    }
  } catch (error) {
    log.warn(`Failed to clear plan.md: ${String(error)}`);
  }
}
