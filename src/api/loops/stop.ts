/**
 * Non-destructive stop route for active loops.
 *
 * - POST /api/loops/:id/stop - Stop the active ACP-backed loop without deleting it
 */

import { loopManager } from "../../core/loop-manager";
import { createLogger } from "../../core/logger";
import { errorResponse, successResponse } from "../helpers";

const log = createLogger("api:loops");

export const loopsStopRoutes = {
  "/api/loops/:id/stop": {
    /**
     * POST /api/loops/:id/stop - Stop an active loop without deleting it.
     *
     * This stops the in-memory engine and asks the backend to cancel the
     * active ACP session. The loop record remains available so the user can
     * inspect it or send another message later.
     *
     * Errors:
     * - 404: Loop not found
     * - 409: Loop exists but is not currently running
     * - 500: Internal error while stopping
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const loop = await loopManager.getLoop(req.params.id);
      if (!loop) {
        return errorResponse("not_found", `Loop not found: ${req.params.id}`, 404);
      }

      const activeStatuses = new Set(["starting", "running", "planning", "waiting"]);
      if (!activeStatuses.has(loop.state.status)) {
        return errorResponse("not_running", `Loop is not running: ${loop.state.status}`, 409);
      }

      try {
        await loopManager.stopLoop(req.params.id);
        return successResponse({ loopId: req.params.id });
      } catch (error) {
        const errorMsg = String(error);
        if (errorMsg.includes("not running")) {
          return errorResponse("not_running", errorMsg, 409);
        }
        log.error("Failed to stop loop", {
          loopId: req.params.id,
          error: errorMsg,
        });
        return errorResponse("stop_loop_failed", errorMsg, 500);
      }
    },
  },
};
