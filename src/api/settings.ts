/**
 * Settings API endpoints for Clanky Tasks Management System.
 * 
 * This module provides endpoints for:
 * - Getting application configuration
 * - Resetting database
 * 
 * Note: Server settings and connection management are now per-workspace.
 * Use the workspace API to get/update server settings and test connections
 * for a specific workspace.
 * 
 * @module api/settings
 */

import { backendManager } from "../core/backend-manager";
import { getAppConfig } from "../core/config";
import { deleteAndReinitializeDatabase } from "../persistence/database";
import { createLogger } from "../core/logger";
import { getPublicBasePathFromForwardedPrefix } from "../utils/public-base-path";
import { getPasskeyAuthStatus } from "../core/passkey-auth";
import { listWorkspaces } from "../persistence/workspaces";
import { taskManager } from "../core/task-manager";
import { purgeArchivedWorkspaceTasks } from "./workspaces/archived-task-purge";
import { errorResponse, successResponse } from "./helpers";

const log = createLogger("api:settings");

/**
 * Settings API routes.
 * 
 * Provides endpoints for application configuration and management:
 * - GET /api/config - Get application configuration
 * - POST /api/settings/reset-all - Delete and reinitialize database
 * - POST /api/server/kill - Terminate the server process (for container restart)
 * 
 * Note: Global server settings and connection reset endpoints have been removed.
 * Server settings and connection management are now per-workspace via the workspace API.
 */
export const settingsRoutes = {
  "/api/config": {
    /**
     * GET /api/config - Get application configuration.
     * 
     * Returns settings that affect app behavior based on environment.
     * Currently includes:
     * - remoteOnly: Whether local stdio transport is disabled (CLANKY_REMOTE_ONLY)
     * 
     * @returns AppConfig object
     */
    async GET(req: Request): Promise<Response> {
      log.debug("GET /api/config");
      const config = getAppConfig();
      const passkeyAuth = await getPasskeyAuthStatus(req);
      const publicBasePath = getPublicBasePathFromForwardedPrefix(
        req.headers.get("x-forwarded-prefix"),
      );
      const responseConfig = {
        ...config,
        passkeyAuth,
        publicBasePath: publicBasePath || null,
      };
      log.debug("Returning app config", {
        remoteOnly: config.remoteOnly,
        passkeyRequired: passkeyAuth.passkeyRequired,
        passkeyAuthenticated: passkeyAuth.authenticated,
        publicBasePath: publicBasePath || null,
      });
      return Response.json(responseConfig);
    },
  },

  "/api/settings/reset-all": {
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
    async POST(): Promise<Response> {
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
    /**
     * POST /api/settings/purge-terminal-tasks - Purge terminal-state tasks across all workspaces.
     *
     * This is a DESTRUCTIVE operation that permanently deletes tasks in terminal states
     * while leaving workspaces, sessions, and preferences intact.
     */
    async POST(): Promise<Response> {
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

  "/api/server/kill": {
    /**
     * POST /api/server/kill - Terminate the server process.
     * 
     * This is a DESTRUCTIVE operation that terminates the Clanky server process.
     * In containerized environments (e.g., Kubernetes), this will cause the container
     * to restart, potentially pulling an updated image.
     * 
     * The server sends a success response before scheduling the exit to ensure
     * the client receives confirmation that the kill was initiated.
     * 
     * @returns Success response with message, then server terminates
     */
    async POST(): Promise<Response> {
      log.warn("POST /api/server/kill - Server kill requested");
      
      // Schedule the server termination after a short delay to allow the response to be sent
      setTimeout(() => {
        log.info("Server is shutting down...");
        // Exit with code 0 to indicate intentional termination
        // In k8s, the container will restart based on the restart policy
        process.exit(0);
      }, 100);
      
      return Response.json({ 
        success: true, 
        message: "Server is shutting down. The connection will be lost." 
      });
    },
  },
};
