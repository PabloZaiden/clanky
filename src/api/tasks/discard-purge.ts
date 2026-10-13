import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task discard and purge routes.
 *
 * - POST /api/tasks/:id/discard - Mark a task deleted and attempt Git cleanup
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
    description: "Discard a task; provider, session, and Git cleanup is best-effort.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Discards task work and schedules provider, session, and Git cleanup.", completion: "admission" } },
    },
    /**
     * POST /api/tasks/:id/discard - Discard a task.
     *
     * Marks the task as deleted before attempting provider, session, credential,
     * and Git cleanup. A cleanup failure does not block deletion; a dedicated
     * worktree can remain until purge.
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
    description: "Permanently delete an eligible task; external cleanup is best-effort.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Permanently deletes the task and schedules external cleanup.", completion: "admission" } },
    },
    /**
     * POST /api/tasks/:id/purge - Permanently delete a task from storage.
     *
     * Removes the task from the database entirely. Drafts are removed immediately.
     * Other tasks only work in final states (accepted_local, merged, pushed, deleted).
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
