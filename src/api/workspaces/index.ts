/**
 * Workspace API endpoints for Clanky Tasks Management System.
 *
 * This module aggregates all workspace sub-module routes into a single export.
 *
 * @module api/workspaces
 */

import { defineRoutes } from "@pablozaiden/webapp/server";

import { crudRoutes } from "./crud";
import { archivedTasksRoutes } from "./archived-tasks";
import { serverSettingsRoutes } from "./server-settings";
import { exportImportRoutes } from "./export-import";
import { workspaceFilesRoutes } from "./files";
import { workspaceMaintenanceRoutes } from "./maintenance";

export const workspacesRoutes = defineRoutes({
  ...exportImportRoutes,
  ...workspaceFilesRoutes,
  ...workspaceMaintenanceRoutes,
  ...serverSettingsRoutes,
  ...archivedTasksRoutes,
  ...crudRoutes,
});
