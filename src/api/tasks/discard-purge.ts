import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task discard and purge routes.
 *
 * - POST /api/tasks/:id/discard - Discard task and delete its git branch
 * - POST /api/tasks/:id/purge   - Permanently delete a task from storage
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { successResponse } from "../helpers";
import { taskErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

export const tasksDiscardPurgeRoutes = defineRoutes({
  "/api/tasks/:id/discard": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Discard a task and remove its working branch.",
    /**
     * POST /api/tasks/:id/discard - Discard a task and delete its git branch.
     *
     * Deletes the task's working branch and marks the task as deleted.
     * After discard, the task can be purged to permanently remove it.
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      log.debug("POST /api/tasks/:id/discard", { taskId: ctx.params["id"]! });
      const result = await taskManager.discardTask(ctx.params["id"]!);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/discard - Failed", {
          taskId: ctx.params["id"]!,
          errorCode: result.error.code,
        });
        return taskErrorResponse(result.error, {
          error: "discard_failed",
          message: "Failed to discard task",
          status: 400,
        });
      }

      log.info("POST /api/tasks/:id/discard - Task discarded", { taskId: ctx.params["id"]! });
      return successResponse();
    },
  },

  "/api/tasks/:id/purge": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Permanently delete a task from storage.",
    /**
     * POST /api/tasks/:id/purge - Permanently delete a task from storage.
     *
     * Removes the task from the database entirely. Drafts are removed immediately.
     * Other tasks only work in final states (merged, pushed, deleted).
     *
     * @returns Success response
     */
    async POST(_req: Request, ctx): Promise<Response> {
      log.debug("POST /api/tasks/:id/purge", { taskId: ctx.params["id"]! });
      const result = await taskManager.purgeTask(ctx.params["id"]!);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/purge - Failed", {
          taskId: ctx.params["id"]!,
          errorCode: result.error.code,
        });
        return taskErrorResponse(result.error, {
          error: "purge_failed",
          message: "Failed to purge task",
          status: 400,
        });
      }

      log.info("POST /api/tasks/:id/purge - Task purged", { taskId: ctx.params["id"]! });
      return successResponse();
    },
  },
});
