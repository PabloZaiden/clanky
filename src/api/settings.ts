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

import { createLogger } from "@pablozaiden/webapp/server";
import { isDomainError } from "../core/domain-error";
import { settingsMaintenanceService } from "../core/settings-maintenance-service";
import { internalErrorResponse, successResponse } from "./helpers";

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
    auth: "owner",
    sameOrigin: "mutations",
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
         await settingsMaintenanceService.resetAll();
        
         log.info("All settings have been reset successfully");
        return Response.json({ 
          success: true, 
          message: "All settings have been reset. Database recreated." 
        });
      } catch (error) {
        if (isDomainError(error) && error.code === "reset_failed") {
          return internalErrorResponse(error, {
            error: "reset_failed",
            message: "Failed to reset settings",
            status: 500,
          }, {
            reset_failed: { status: 500, message: "Failed to reset settings" },
          });
        }
        log.error("Failed to reset all settings", { error: String(error) });
        return internalErrorResponse(error, {
          error: "reset_failed",
          message: "Failed to reset settings",
          status: 500,
        });
      }
    },
  },

  "/api/settings/purge-terminal-tasks": {
    auth: "owner",
    sameOrigin: "mutations",
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
        const result = await settingsMaintenanceService.purgeTerminalTasks();
        log.info("POST /api/settings/purge-terminal-tasks - Completed", {
          workspaceCount: result.totalWorkspaces,
          totalArchived: result.totalArchived,
          purgedCount: result.purgedCount,
          failureCount: result.failures.length,
        });

        return successResponse({ ...result });
      } catch (error) {
        if (isDomainError(error) && error.code === "purge_terminal_tasks_failed") {
          return internalErrorResponse(error, {
            error: "purge_terminal_tasks_failed",
            message: "Failed to purge terminal-state tasks",
            status: 500,
          }, {
            purge_terminal_tasks_failed: {
              status: 500,
              message: "Failed to purge terminal-state tasks",
            },
          });
        }
        log.error("Failed to purge terminal-state tasks across all workspaces", { error: String(error) });
        return internalErrorResponse(error, {
          error: "purge_terminal_tasks_failed",
          message: "Failed to purge terminal-state tasks",
          status: 500,
        });
      }
    },
  },
});
