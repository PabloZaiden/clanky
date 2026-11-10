/**
 * Barrel re-export for the models API sub-modules.
 *
 * @module api/models
 */

export * from "./models-routes";
export * from "./preferences-routes";

import { modelsRoutes } from "./models-routes";
import { preferencesRoutes } from "./preferences-routes";
import { sidebarPinsRoutes } from "./sidebar-pins-routes";

/**
 * All models and preferences routes combined.
 * Can be spread into the main API routes object.
 */
import { defineRoutes } from "@/platform/server";

export const modelsAndPreferencesRoutes = defineRoutes({
  ...modelsRoutes,
  ...preferencesRoutes,
  ...sidebarPinsRoutes,
});
