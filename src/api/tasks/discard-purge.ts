/**
 * Task discard and purge routes.
 *
 * - POST /api/tasks/:id/discard - Discard task and delete its git branch
 * - POST /api/tasks/:id/purge   - Permanently delete a task from storage
 */

import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { errorResponse, successResponse } from "../helpers";

const log = createLogger("api:tasks");

export const tasksDiscardPurgeRoutes = {
  "/api/tasks/:id/discard": {
    /**
     * POST /api/tasks/:id/discard - Discard a task and delete its git branch.
     *
     * Deletes the task's working branch and marks the task as deleted.
     * After discard, the task can be purged to permanently remove it.
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/tasks/:id/discard", { taskId: req.params.id });
      const result = await taskManager.discardTask(req.params.id);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/discard - Failed", { taskId: req.params.id, error: result.error });
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        return errorResponse("discard_failed", result.error ?? "Unknown error", 400);
      }

      log.info("POST /api/tasks/:id/discard - Task discarded", { taskId: req.params.id });
      return successResponse();
    },
  },

  "/api/tasks/:id/purge": {
    /**
     * POST /api/tasks/:id/purge - Permanently delete a task from storage.
     *
     * Removes the task from the database entirely. Drafts are removed immediately.
     * Other tasks only work in final states (merged, pushed, deleted).
     *
     * @returns Success response
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/tasks/:id/purge", { taskId: req.params.id });
      const result = await taskManager.purgeTask(req.params.id);

      if (!result.success) {
        log.warn("POST /api/tasks/:id/purge - Failed", { taskId: req.params.id, error: result.error });
        if (result.error?.includes("not found")) {
          return errorResponse("not_found", "Task not found", 404);
        }
        return errorResponse("purge_failed", result.error ?? "Unknown error", 400);
      }

      log.info("POST /api/tasks/:id/purge - Task purged", { taskId: req.params.id });
      return successResponse();
    },
  },
};
