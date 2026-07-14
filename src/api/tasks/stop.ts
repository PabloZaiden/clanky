import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Non-destructive stop route for active tasks.
 *
 * - POST /api/tasks/:id/stop - Stop the active ACP-backed task without deleting it
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { domainErrorResponse, errorResponse, successResponse } from "../helpers";
import { isTaskOperationError } from "../../core/task/task-errors";
import { taskErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

export const tasksStopRoutes = defineRoutes({
  "/api/tasks/:id/stop": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Stop an active task run.",
    /**
     * POST /api/tasks/:id/stop - Stop an active task without deleting it.
     *
     * This stops the in-memory engine and asks the backend to cancel the
     * active ACP session. The task record remains available so the user can
     * inspect it or send another message later.
     *
     * Errors:
     * - 404: Task not found
     * - 409: Task exists but is not currently running
     * - 500: Internal error while stopping
     */
    async POST(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
      if (!task) {
        return errorResponse("not_found", `Task not found: ${ctx.params["id"]!}`, 404);
      }

      const activeStatuses = new Set(["starting", "running", "planning", "waiting"]);
      if (!activeStatuses.has(task.state.status)) {
        return errorResponse("not_running", `Task is not running: ${task.state.status}`, 409);
      }

      try {
        await taskManager.stopTask(ctx.params["id"]!);
        return successResponse({ taskId: ctx.params["id"]! });
      } catch (error) {
        if (isTaskOperationError(error)) {
          return taskErrorResponse(error, {
            error: "stop_task_failed",
            message: "Failed to stop task",
            status: 500,
          });
        }
        log.error("Failed to stop task", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "stop_task_failed",
            message: "Failed to stop task",
            status: 500,
          },
        });
      }
    },
  },
});
