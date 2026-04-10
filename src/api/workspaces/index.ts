/**
 * Workspace API endpoints for Ralph Loops Management System.
 *
 * This module aggregates all workspace sub-module routes into a single export.
 *
 * @module api/workspaces
 */

import { crudRoutes } from "./crud";
import { archivedLoopsRoutes } from "./archived-loops";
import { byDirectoryRoutes } from "./by-directory";
import { serverSettingsRoutes } from "./server-settings";
import { exportImportRoutes } from "./export-import";
import { workspaceFilesRoutes } from "./files";
import { workspaceMaintenanceRoutes } from "./maintenance";

export const workspacesRoutes = {
  ...crudRoutes,
  ...archivedLoopsRoutes,
  ...byDirectoryRoutes,
  ...serverSettingsRoutes,
  ...exportImportRoutes,
  ...workspaceFilesRoutes,
  ...workspaceMaintenanceRoutes,
};
