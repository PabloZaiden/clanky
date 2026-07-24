import type { TaskCtx } from "./context";
import { backendManager } from "../backend-manager";
import { log } from "@pablozaiden/webapp/server";

export function startStatePersistenceImpl(ctx: TaskCtx, taskId: string): void {
  const interval = setInterval(() => {
    const engine = ctx.engines.get(taskId);
    if (!engine) {
      clearInterval(interval);
      return;
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
