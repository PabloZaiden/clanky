/**
 * Barrel re-export for the models API sub-modules.
 *
 * @module api/models
 */

export * from "./model-discovery";
export * from "./models-routes";
export * from "./preferences-routes";

import { modelsRoutes } from "./models-routes";
import { preferencesRoutes } from "./preferences-routes";

/**
 * All models and preferences routes combined.
 * Can be spread into the main API routes object.
 */
import { defineRoutes } from "@pablozaiden/webapp/server";

export const modelsAndPreferencesRoutes = defineRoutes({
  ...modelsRoutes,
  ...preferencesRoutes,
});
