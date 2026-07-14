import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Route handler for purging archived tasks within a workspace.
 */

import { createLogger } from "../../core/logger";
import { isDomainError } from "../../core/domain-error";
import { purgeArchivedWorkspaceTasks } from "../../core/settings-maintenance-service";
import { errorResponse, successResponse } from "../helpers";

const log = createLogger("api:workspaces");

export const archivedTasksRoutes = defineRoutes({
  /**
   * POST /api/workspaces/:id/archived-tasks/purge - Purge all archived tasks for a workspace.
   */
  "/api/workspaces/:id/archived-tasks/purge": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Purge archived tasks for a workspace.",
    async POST(req: Request, ctx) {
      ctx.server?.timeout(req, 0);
      const id = ctx.params["id"]!;
      log.debug("POST /api/workspaces/:id/archived-tasks/purge", { workspaceId: id });

      try {
        const purgeResult = await purgeArchivedWorkspaceTasks(id);

        log.info("POST /api/workspaces/:id/archived-tasks/purge - Completed", {
          workspaceId: id,
          totalArchived: purgeResult.totalArchived,
          purgedCount: purgeResult.purgedCount,
          failureCount: purgeResult.failures.length,
        });

        return successResponse({ ...purgeResult });
      } catch (error) {
        if (isDomainError(error) && error.code === "workspace_not_found") {
          return errorResponse("workspace_not_found", "Workspace not found", 404);
        }
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
});
