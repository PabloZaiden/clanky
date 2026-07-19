import type { TaskCtx } from "./context";
import type { Task } from "@/shared/task";
import type { CommandExecutor } from "../command-executor";
import { updateTaskState } from "../../persistence/tasks";
import { log } from "@pablozaiden/webapp/server";
import { ensurePlanningDirectory } from "../planning-directory";
import { getPlanFilePath } from "../../lib/planning-files";

export async function clearPlanningFilesImpl(
  _ctx: TaskCtx,
  taskId: string,
  task: Task,
  executor: CommandExecutor,
  worktreePath: string
): Promise<void> {
  const planningDir = await ensurePlanningDirectory(executor, worktreePath);

  if (task.config.clearPlanningFolder && !task.state.planMode?.planningFolderCleared) {
    try {
      const files = await executor.listDirectory(planningDir);
      const filesToDelete = files.filter((file: string) => file !== ".gitkeep");

      if (filesToDelete.length > 0) {
        const fileArgs = filesToDelete.map((file: string) => `${planningDir}/${file}`);
        const result = await executor.exec("rm", ["-rf", ...fileArgs], {
          cwd: worktreePath,
        });
        if (!result.success) {
          throw new Error(`Failed to clear ${planningDir}: ${result.stderr || result.stdout || "unknown error"}`);
        }
      }

      if (task.state.planMode) {
        task.state.planMode.planningFolderCleared = true;
        await updateTaskState(taskId, task.state);
      }
    } catch (error) {
      log.warn(`Failed to clear .clanky-planning folder: ${String(error)}`);
    }
  }

  const planFilePath = getPlanFilePath(worktreePath);
  try {
    const planFileExists = await executor.fileExists(planFilePath);
    if (planFileExists) {
      await executor.exec("rm", ["-f", planFilePath], { cwd: worktreePath });
      log.debug("Cleared stale plan.md file before starting plan mode");
    }
  } catch (error) {
    log.warn(`Failed to clear plan.md: ${String(error)}`);
  }
}
