import type { LoopCtx } from "./context";
import type { Loop } from "../../types/loop";
import type { CommandExecutor } from "../command-executor";
import { updateLoopState } from "../../persistence/loops";
import { log } from "../logger";
import { ensurePlanningDirectory } from "../planning-directory";
import { getPlanFilePath } from "../../lib/planning-files";

export async function clearPlanningFilesImpl(
  _ctx: LoopCtx,
  loopId: string,
  loop: Loop,
  executor: CommandExecutor,
  worktreePath: string
): Promise<void> {
  const planningDir = await ensurePlanningDirectory(executor, worktreePath);

  if (loop.config.clearPlanningFolder && !loop.state.planMode?.planningFolderCleared) {
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

      if (loop.state.planMode) {
        loop.state.planMode.planningFolderCleared = true;
        await updateLoopState(loopId, loop.state);
      }
    } catch (error) {
      log.warn(`Failed to clear .ralph-planning folder: ${String(error)}`);
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
