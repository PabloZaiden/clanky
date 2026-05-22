/**
 * Route handler for purging archived tasks within a workspace.
 */

import { createLogger } from "../../core/logger";
import { purgeArchivedWorkspaceTasks } from "./archived-task-purge";
import {
  requireWorkspace,
  errorResponse,
  successResponse,
} from "../helpers";

const log = createLogger("api:workspaces");

export const archivedTasksRoutes = {
  /**
   * POST /api/workspaces/:id/archived-tasks/purge - Purge all archived tasks for a workspace.
   */
  "/api/workspaces/:id/archived-tasks/purge": {
    async POST(req: Request & { params: { id: string } }) {
      const { id } = req.params;
      log.debug("POST /api/workspaces/:id/archived-tasks/purge", { workspaceId: id });

      try {
        const workspace = await requireWorkspace(id);
        if (workspace instanceof Response) {
          return workspace;
        }

        const purgeResult = await purgeArchivedWorkspaceTasks(id);

        log.info("POST /api/workspaces/:id/archived-tasks/purge - Completed", {
          workspaceId: id,
          totalArchived: purgeResult.totalArchived,
          purgedCount: purgeResult.purgedCount,
          failureCount: purgeResult.failures.length,
        });

        return successResponse({ ...purgeResult });
      } catch (error) {
        log.error("Failed to purge archived workspace tasks:", {
          workspaceId: id,
          error: String(error),
        });
        return errorResponse(
          "purge_archived_failed",
          `Failed to purge archived workspace tasks: ${String(error)}`,
          500,
        );
      }
    },
  },
};
