import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Route handlers for exporting and importing workspace configurations.
 */

import {
  createWorkspace,
  exportWorkspaces,
} from "../../persistence/workspaces";
import { backendManager } from "../../core/backend-manager";
import { createLogger } from "../../core/logger";
import { getDefaultServerSettings } from "../../types/settings";
import type { Workspace, WorkspaceImportResult } from "../../types/workspace";
import type { WorkspaceExportData } from "../../types/schemas";
import { parseAndValidate } from "../validation";
import { SensitiveQuerySchema } from "../route-schemas";
import { errorResponse } from "../helpers";
import { WorkspaceImportRequestSchema } from "../../types/schemas";
import { sanitizeServerSettings, shouldIncludeSensitiveData } from "../../lib/sensitive-data";

const log = createLogger("api:workspaces");

/**
 * Import workspaces with directory validation.
 * Each workspace's directory is validated on the remote server (via backendManager)
 * before being created. Workspaces that fail validation are reported as "failed"
 * in the result details, rather than silently creating invalid entries. Every
 * valid entry receives a new workspace ID, even when its directory matches
 * another workspace.
 *
 * This mirrors the validation enforced by POST /api/workspaces.
 */
async function importWorkspacesWithValidation(
  data: WorkspaceExportData,
): Promise<WorkspaceImportResult> {
  log.debug("Importing workspaces with validation", { count: data.workspaces.length });

  const result: WorkspaceImportResult = {
    created: 0,
    failed: 0,
    details: [],
  };

  for (const config of data.workspaces) {
    const name = config.name.trim();
    const directory = config.directory.trim();
    const serverSettings = config.serverSettings ?? getDefaultServerSettings();

    // Validate directory on the remote server (same validation as POST /api/workspaces)
    try {
      const validation = await backendManager.validateRemoteDirectory(
        serverSettings,
        directory,
      );

      if (!validation.success) {
        log.warn("Import: failed to validate remote directory", {
          name,
          directory,
          error: validation.error,
        });
        result.failed++;
        result.details.push({
          name,
          directory,
          status: "failed",
          reason: `Failed to validate directory: ${validation.error}`,
        });
        continue;
      }

      if (validation.directoryExists === false) {
        log.warn("Import: directory does not exist on remote server", {
          name,
          directory,
        });
        result.failed++;
        result.details.push({
          name,
          directory,
          status: "failed",
          reason: "Directory does not exist on the remote server",
        });
        continue;
      }

      if (!validation.isGitRepo) {
        log.warn("Import: directory is not a git repository", {
          name,
          directory,
        });
        result.failed++;
        result.details.push({
          name,
          directory,
          status: "failed",
          reason: "Directory is not a git repository",
        });
        continue;
      }
    } catch (error) {
      log.warn("Import: unexpected error during directory validation", {
        name,
        directory,
        error: String(error),
      });
      result.failed++;
      result.details.push({
        name,
        directory,
        status: "failed",
        reason: `Validation error: ${String(error)}`,
      });
      continue;
    }

    // Validation passed — create the workspace
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name,
      directory,
      serverSettings,
      createdAt: now,
      updatedAt: now,
      archived: config.archived === true,
    };

    await createWorkspace(workspace);
    result.created++;
    result.details.push({
      name: config.name,
      directory: config.directory,
      status: "created",
    });
  }

  log.info("Workspaces imported with validation", {
    created: result.created,
    failed: result.failed,
  });
  return result;
}

export const exportImportRoutes = defineRoutes({
  /**
   * GET /api/workspaces/export - Export all workspace configs as JSON
   */
  "/api/workspaces/export": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Export workspace configuration data.",
    querySchema: SensitiveQuerySchema,
    async GET(req: Request, _ctx) {
      log.debug("GET /api/workspaces/export - Exporting workspace configs");
      try {
        const includeSensitive = shouldIncludeSensitiveData(req);
        const exportData = await exportWorkspaces();
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

  /**
   * POST /api/workspaces/import - Import workspace configs from JSON.
   * Validates each workspace's directory on the remote server before creating it.
   * Reports per-entry results (created, failed).
   */
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

      const data = result.data;

      // Normalize inputs (trim whitespace from name and directory) before passing
      // to the persistence layer, consistent with POST /api/workspaces behavior.
      const normalizedData = {
        ...data,
        workspaces: data.workspaces.map((ws) => ({
          ...ws,
          name: ws.name.trim(),
          directory: ws.directory.trim(),
        })),
      };

      try {
        // Validate each workspace's directory on the remote server before importing
        const importResult = await importWorkspacesWithValidation(normalizedData);
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
