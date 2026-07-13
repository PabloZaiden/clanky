import { defineRoutes, type RouteContext } from "@pablozaiden/webapp/server";
/**
 * Settings API endpoints for Clanky Tasks Management System.
 * 
 * This module provides endpoints for:
 * - Resetting database
 * 
 * Note: Server settings and connection management are now per-workspace.
 * Use the workspace API to get/update server settings and test connections
 * for a specific workspace.
 * 
 * @module api/settings
 */

import { backendManager } from "../core/backend-manager";
import { deleteAndReinitializeDatabase } from "../persistence/database";
import { createLogger } from "../core/logger";
import { listWorkspaces } from "../persistence/workspaces";
import { taskManager } from "../core/task-manager";
import { purgeArchivedWorkspaceTasks } from "./workspaces/archived-task-purge";
import { errorResponse, successResponse } from "./helpers";

const log = createLogger("api:settings");

/**
 * Settings API routes.
 * 
 * Provides endpoints for Clanky-specific management:
 * - POST /api/settings/reset-all - Delete and reinitialize database
 * 
 * Note: Global server settings and connection reset endpoints have been removed.
 * Server settings and connection management are now per-workspace via the workspace API.
 */
export const settingsRoutes = defineRoutes({
  "/api/settings/reset-all": {
    description: "Reset all persisted settings and recreate the database.",
    /**
     * POST /api/settings/reset-all - Delete database and reinitialize.
     * 
     * This is a DESTRUCTIVE operation that:
     * 1. Resets all backend connections
     * 2. Deletes the database file
     * 3. Recreates the database with all migrations applied
     * 
     * All tasks, sessions, workspaces, and preferences will be permanently deleted.
     * 
     * @returns Success response with message
     */
    async POST(_req: Request, _ctx: RouteContext): Promise<Response> {
       log.warn("POST /api/settings/reset-all - Resetting all settings");
      try {
        // Reset all backend connections first
        log.debug("Resetting all backend connections");
        await backendManager.resetAllConnections();
        
        // Delete and reinitialize the database
        log.debug("Deleting and reinitializing database");
        await deleteAndReinitializeDatabase();
        
        log.info("All settings have been reset successfully");
        return Response.json({ 
          success: true, 
          message: "All settings have been reset. Database recreated." 
        });
      } catch (error) {
        log.error("Failed to reset all settings", { error: String(error) });
        return errorResponse("reset_failed", String(error), 500);
      }
    },
  },

  "/api/settings/purge-terminal-tasks": {
    description: "Purge terminal-state tasks across all workspaces.",
    /**
     * POST /api/settings/purge-terminal-tasks - Purge terminal-state tasks across all workspaces.
     *
     * This is a DESTRUCTIVE operation that permanently deletes tasks in terminal states
     * while leaving workspaces, sessions, and preferences intact.
     */
    async POST(_req: Request, ctx: RouteContext): Promise<Response> {
       ctx.server?.timeout(_req, 0);
       log.warn("POST /api/settings/purge-terminal-tasks - Purging terminal-state tasks across all workspaces");

      try {
        const [workspaces, tasks] = await Promise.all([
          listWorkspaces(),
          taskManager.getAllTasks(),
        ]);

        const workspacesResults = [];
        for (const workspace of workspaces) {
          workspacesResults.push(await purgeArchivedWorkspaceTasks(workspace.id, tasks));
        }

        const totalArchived = workspacesResults.reduce((total, result) => total + result.totalArchived, 0);
        const purgedCount = workspacesResults.reduce((total, result) => total + result.purgedCount, 0);
        const purgedTaskIds = workspacesResults.flatMap((result) => result.purgedTaskIds);
        const failures = workspacesResults.flatMap((result) =>
          result.failures.map((failure) => ({
            workspaceId: result.workspaceId,
            ...failure,
          })),
        );

        log.info("POST /api/settings/purge-terminal-tasks - Completed", {
          workspaceCount: workspaces.length,
          totalArchived,
          purgedCount,
          failureCount: failures.length,
        });

        return successResponse({
          totalWorkspaces: workspaces.length,
          totalArchived,
          purgedCount,
          purgedTaskIds,
          failures,
          workspaces: workspacesResults,
        });
      } catch (error) {
        log.error("Failed to purge terminal-state tasks across all workspaces", { error: String(error) });
        return errorResponse(
          "purge_terminal_tasks_failed",
          `Failed to purge terminal-state tasks: ${String(error)}`,
          500,
        );
      }
    },
  },
});
