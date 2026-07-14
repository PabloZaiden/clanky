import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Route handlers for workspace server settings: CRUD, status, and test connection.
 */

import { updateWorkspace } from "../../persistence/workspaces";
import { backendManager } from "../../core/backend-manager";
import { createLogger } from "../../core/logger";
import { areServerSettingsEqual } from "../../types/settings";
import { parseAndValidate } from "../validation";
import {
  requireWorkspace,
  errorResponse,
} from "../helpers";
import { sanitizeServerSettings, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import {
  ServerSettingsSchema,
  TestConnectionRequestSchema,
} from "../../types/schemas";
import { SensitiveQuerySchema } from "../route-schemas";

const log = createLogger("api:workspaces");

export const serverSettingsRoutes = defineRoutes({
  /**
   * GET /api/workspaces/:id/server-settings - Get workspace server settings
   * PUT /api/workspaces/:id/server-settings - Update workspace server settings
   */
  "/api/workspaces/:id/server-settings": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or update workspace server settings.",
    requestSchema: ServerSettingsSchema,
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, ctx) {
        const id = ctx.params["id"]!;
        try {
          const result = await requireWorkspace(id);
          if (result instanceof Response) return result;
          return Response.json(
            shouldIncludeSensitiveData(req)
              ? result.serverSettings
              : sanitizeServerSettings(result.serverSettings),
          );
        } catch (error) {
          log.error("Failed to get workspace server settings:", String(error));
          return errorResponse("get_settings_failed", `Failed to get server settings: ${String(error)}`, 500);
      }
    },

    async PUT(req: Request, ctx) {
      const id = ctx.params["id"]!;
      const includeSensitive = shouldIncludeSensitiveData(req);
      const result = await parseAndValidate(ServerSettingsSchema, req);

      if (!result.success) {
        return result.response;
      }

      const body = result.data;

      try {
        const currentWorkspace = await requireWorkspace(id);
        if (currentWorkspace instanceof Response) {
          return currentWorkspace;
        }

        const settingsChanged = !areServerSettingsEqual(currentWorkspace.serverSettings, body);

        if (!settingsChanged) {
          log.info(`Server settings unchanged for workspace: ${currentWorkspace.name}`);
          return Response.json(
            includeSensitive
              ? currentWorkspace.serverSettings
              : sanitizeServerSettings(currentWorkspace.serverSettings),
          );
        }

        const workspace = await updateWorkspace(id, { serverSettings: body });
        if (!workspace) {
          return errorResponse("workspace_not_found", "Workspace not found", 404);
        }

        // Reset the connection for this workspace so it picks up new settings
        await backendManager.resetWorkspaceConnection(id);

        log.info(`Updated server settings for workspace: ${workspace.name}`);
        return Response.json(
          includeSensitive
            ? workspace.serverSettings
            : sanitizeServerSettings(workspace.serverSettings),
        );
      } catch (error) {
        log.error("Failed to update workspace server settings:", String(error));
        return errorResponse("update_settings_failed", `Failed to update server settings: ${String(error)}`, 500);
      }
    },
  },

  /**
   * GET /api/workspaces/:id/server-settings/status - Get connection status for workspace
   */
  "/api/workspaces/:id/server-settings/status": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the current workspace connection status.",
    async GET(_req: Request, ctx) {
      const id = ctx.params["id"]!;
      try {
        const result = await requireWorkspace(id);
        if (result instanceof Response) return result;

        const status = await backendManager.getWorkspaceStatus(id);
        return Response.json(status);
      } catch (error) {
        log.error("Failed to get workspace connection status:", String(error));
        return errorResponse("status_failed", `Failed to get connection status: ${String(error)}`, 500);
      }
    },
  },

  /**
   * POST /api/workspaces/:id/server-settings/test - Test connection for workspace
   * Optionally accepts settings in the body to test proposed settings.
   * If no body, uses the workspace's current settings.
   */
  "/api/workspaces/:id/server-settings/test": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Test the configured workspace connection using workspace settings.",
    requestSchema: TestConnectionRequestSchema,
    async POST(req: Request, ctx) {
      const id = ctx.params["id"]!;
      try {
        const workspace = await requireWorkspace(id);
        if (workspace instanceof Response) return workspace;

        // Optionally accept settings in the body to test proposed settings
        // If no body, use the workspace's current settings
        let settings = workspace.serverSettings;

        const bodyText = await req.text();
        if (bodyText.trim()) {
          let bodyJson: unknown;
          try {
            bodyJson = JSON.parse(bodyText);
          } catch {
            return errorResponse("invalid_json", "Request body must be valid JSON", 400);
          }

          // Allow "{}" as shorthand for "use current settings".
          if (
            typeof bodyJson === "object"
            && bodyJson !== null
            && !Array.isArray(bodyJson)
            && Object.keys(bodyJson).length === 0
          ) {
            settings = workspace.serverSettings;
          } else {
            const parsedSettings = ServerSettingsSchema.safeParse(bodyJson);
            if (!parsedSettings.success) {
              const firstIssue = parsedSettings.error.issues[0]?.message ?? "Invalid server settings";
              return errorResponse("validation_error", firstIssue, 400);
            }
            settings = parsedSettings.data;
          }
        }

        const result = await backendManager.testConnection(settings, workspace.directory);
        return Response.json(result);
      } catch (error) {
        log.error("Failed to test workspace connection:", String(error));
        return errorResponse("test_failed", `Failed to test connection: ${String(error)}`, 500);
      }
    },
  },

  /**
   * POST /api/server-settings/test - Test connection without requiring a workspace.
   * Used by the create workspace modal to test connection before creating the workspace.
   * Expects { settings: ServerSettings, directory: string } in the body.
   */
  "/api/server-settings/test": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Test a server connection without creating a workspace.",
    requestSchema: TestConnectionRequestSchema,
    async POST(req: Request, _ctx) {
      const result = await parseAndValidate(TestConnectionRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      const { settings, directory } = result.data;

      try {
        const testResult = await backendManager.testConnection(settings, directory);
        return Response.json(testResult);
      } catch (error) {
        log.error("Failed to test connection:", String(error));
        return Response.json(
          { success: false, error: String(error) },
          { status: 500 },
        );
      }
    },
  },
});
