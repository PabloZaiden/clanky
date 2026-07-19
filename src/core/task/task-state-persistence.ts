import type { TaskCtx } from "./context";
import { updateTaskState } from "../../persistence/tasks";
import { backendManager } from "../backend-manager";
import { log } from "@pablozaiden/webapp/server";

export function startStatePersistenceImpl(ctx: TaskCtx, taskId: string): void {
  const interval = setInterval(async () => {
    const engine = ctx.engines.get(taskId);
    if (!engine) {
      clearInterval(interval);
      return;
    }

    try {
      await updateTaskState(taskId, engine.state);
    } catch (error) {
      log.error(`Failed to persist task state: ${String(error)}`);
    }

    if (
      engine.state.status === "completed" ||
      engine.state.status === "stopped" ||
      engine.state.status === "failed" ||
      engine.state.status === "max_iterations"
    ) {
      clearInterval(interval);
      backendManager.disconnectTask(taskId).catch((error) => {
        log.error(`Failed to disconnect task backend during cleanup: ${String(error)}`);
      });
      ctx.engines.delete(taskId);
    }
  }, 5000);
}
