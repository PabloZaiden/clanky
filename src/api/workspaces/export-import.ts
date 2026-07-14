import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Route handlers for exporting and importing workspace configurations.
 */

import { createLogger } from "../../core/logger";
import { workspaceManager } from "../../core/workspace-manager";
import type { WorkspaceImportResult } from "../../types/workspace";
import { WorkspaceImportRequestSchema } from "../../types/schemas";
import { sanitizeServerSettings, shouldIncludeSensitiveData } from "../../lib/sensitive-data";
import { parseAndValidate } from "../validation";
import { SensitiveQuerySchema } from "../route-schemas";
import { errorResponse } from "../helpers";

const log = createLogger("api:workspaces");

export const exportImportRoutes = defineRoutes({
  "/api/workspaces/export": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Export workspace configuration data.",
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, _ctx) {
      log.debug("GET /api/workspaces/export - Exporting workspace configs");
      try {
        const includeSensitive = shouldIncludeSensitiveData(req);
        const exportData = await workspaceManager.exportWorkspaces();
        if (includeSensitive) {
          return Response.json(exportData);
        }
        return Response.json({
          ...exportData,
          workspaces: exportData.workspaces.map((workspace) => ({
            ...workspace,
            serverSettings: sanitizeServerSettings(workspace.serverSettings),
          })),
        });
      } catch (error) {
        log.error("Failed to export workspaces:", String(error));
        return errorResponse("export_failed", `Failed to export workspaces: ${String(error)}`, 500);
      }
    },
  },

  "/api/workspaces/import": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Import workspaces from an export bundle.",
    requestSchema: WorkspaceImportRequestSchema,
    async POST(req: Request, _ctx) {
      log.debug("POST /api/workspaces/import - Importing workspace configs");
      const result = await parseAndValidate(WorkspaceImportRequestSchema, req);

      if (!result.success) {
        log.debug("POST /api/workspaces/import - Validation failed");
        return result.response;
      }

      try {
        const importResult: WorkspaceImportResult = await workspaceManager.importWorkspaces(result.data);
        log.info("Workspace import complete", {
          created: importResult.created,
          failed: importResult.failed,
        });
        return Response.json(importResult);
      } catch (error) {
        log.error("Failed to import workspaces:", String(error));
        return errorResponse("import_failed", `Failed to import workspaces: ${String(error)}`, 500);
      }
    },
  },
});
