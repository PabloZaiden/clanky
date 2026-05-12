/**
 * Loops CRUD routes — thin barrel re-exporting focused sub-modules.
 *
 * - GET /api/loops - List all loops
 * - POST /api/loops - Create a new loop (auto-starts unless draft mode)
 * - POST /api/loops/title - Generate a suggested loop title
 * - GET /api/loops/:id - Get a specific loop
 * - PATCH /api/loops/:id - Update a loop's configuration; name updates are draft-only
 * - PUT /api/loops/:id - Update a draft loop's configuration
 * - DELETE /api/loops/:id - Delete a loop
 * - GET /api/loops/:id/comments - Get all review comments for a loop
 */

import { loopsCollectionRoutes } from "./collection";
import { loopsItemRoutes } from "./item";
import { loopsCommentsRoutes } from "./comments";

export { loopsCollectionRoutes } from "./collection";
export { loopsItemRoutes } from "./item";
export { loopsCommentsRoutes } from "./comments";

export const loopsCrudRoutes = {
  ...loopsCollectionRoutes,
  ...loopsItemRoutes,
  ...loopsCommentsRoutes,
};
