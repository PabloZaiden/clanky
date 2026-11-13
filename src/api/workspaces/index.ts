/**
 * Workspace API endpoints for Clanky.
 *
 * This module aggregates all workspace sub-module routes into a single export.
 *
 * @module api/workspaces
 */

import { defineRoutes } from "@/platform/server";

import { crudRoutes } from "./crud";
import { serverSettingsRoutes } from "./server-settings";
import { workspaceFilesRoutes } from "./files";
import { workspaceMaintenanceRoutes } from "./maintenance";
import { workspaceExecRoutes } from "./exec";
import { workspaceIconRoutes } from "./icons";

export const workspacesRoutes = defineRoutes({
  ...workspaceFilesRoutes,
  ...workspaceMaintenanceRoutes,
  ...serverSettingsRoutes,
  ...crudRoutes,
  ...workspaceExecRoutes,
  ...workspaceIconRoutes,
});
