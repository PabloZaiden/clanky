import type { LoopCtx } from "./context";
import { updateLoopState } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { log } from "../logger";

export function startStatePersistenceImpl(ctx: LoopCtx, loopId: string): void {
  const interval = setInterval(async () => {
    const engine = ctx.engines.get(loopId);
    if (!engine) {
      clearInterval(interval);
      return;
    }

    try {
      await updateLoopState(loopId, engine.state);
    } catch (error) {
      log.error(`Failed to persist loop state: ${String(error)}`);
    }

    if (
      engine.state.status === "completed" ||
      engine.state.status === "stopped" ||
      engine.state.status === "failed" ||
      engine.state.status === "max_iterations"
    ) {
      clearInterval(interval);
      backendManager.disconnectLoop(loopId).catch((error) => {
        log.error(`Failed to disconnect loop backend during cleanup: ${String(error)}`);
      });
      ctx.engines.delete(loopId);
    }
  }, 5000);
}
