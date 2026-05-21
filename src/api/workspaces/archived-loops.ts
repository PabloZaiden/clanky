/**
 * Route handler for purging archived loops within a workspace.
 */

import { createLogger } from "../../core/logger";
import { purgeArchivedWorkspaceLoops } from "./archived-loop-purge";
import {
  requireWorkspace,
  errorResponse,
  successResponse,
} from "../helpers";

const log = createLogger("api:workspaces");

export const archivedLoopsRoutes = {
  /**
   * POST /api/workspaces/:id/archived-loops/purge - Purge all archived loops for a workspace.
   */
  "/api/workspaces/:id/archived-loops/purge": {
    async POST(req: Request & { params: { id: string } }) {
      const { id } = req.params;
      log.debug("POST /api/workspaces/:id/archived-loops/purge", { workspaceId: id });

      try {
        const workspace = await requireWorkspace(id);
        if (workspace instanceof Response) {
          return workspace;
        }

        const purgeResult = await purgeArchivedWorkspaceLoops(id);

        log.info("POST /api/workspaces/:id/archived-loops/purge - Completed", {
          workspaceId: id,
          totalArchived: purgeResult.totalArchived,
          purgedCount: purgeResult.purgedCount,
          failureCount: purgeResult.failures.length,
        });

        return successResponse({ ...purgeResult });
      } catch (error) {
        log.error("Failed to purge archived workspace loops:", {
          workspaceId: id,
          error: String(error),
        });
        return errorResponse(
          "purge_archived_failed",
          `Failed to purge archived workspace loops: ${String(error)}`,
          500,
        );
      }
    },
  },
};
