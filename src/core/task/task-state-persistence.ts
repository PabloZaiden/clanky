import type { TaskCtx } from "./context";
import type { TaskEngine } from "../task-engine";
import { backendManager } from "../backend-manager";
import { log } from "@pablozaiden/webapp/server";
import { runTaskLifecycleOperation } from "./task-lifecycle-operations";

export function startStatePersistenceImpl(ctx: TaskCtx, taskId: string): void {
  let cleanupPending = false;
  const interval = setInterval(() => {
    const engine = ctx.engines.get(taskId);
    if (!engine) {
      clearInterval(interval);
      return;
    }

    if (engine.isExecuting || cleanupPending) {
      return;
    }

    cleanupPending = true;
    void (async () => {
      try {
        if (await cleanupIdleTaskEngineImpl(ctx, taskId, engine)) clearInterval(interval);
      } catch (error) {
        log.error(`Failed to disconnect task backend during cleanup: ${String(error)}`);
      } finally {
        cleanupPending = false;
      }
    })();
  }, 5000);
}

export async function cleanupIdleTaskEngineImpl(
  ctx: TaskCtx,
  taskId: string,
  engine: TaskEngine,
): Promise<boolean> {
  return await runTaskLifecycleOperation(taskId, async () => {
    if (ctx.engines.get(taskId) !== engine) return true;
    if (
      engine.isExecuting
      || engine.needsWorkspaceFinalization
      || !["completed", "stopped", "failed", "max_iterations"].includes(engine.state.status)
    ) {
      return false;
    }

    if (!await backendManager.disconnectTask(taskId)) return false;
    if (ctx.engines.get(taskId) === engine) ctx.engines.delete(taskId);
    return true;
  });
}
