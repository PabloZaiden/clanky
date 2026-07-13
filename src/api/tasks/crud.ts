import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Tasks CRUD routes — thin barrel re-exporting focused sub-modules.
 *
 * - GET /api/tasks - List all tasks
 * - POST /api/tasks - Create a new task (auto-starts unless draft mode)
 * - POST /api/tasks/title - Generate a suggested task title
 * - GET /api/tasks/:id - Get a specific task
 * - PATCH /api/tasks/:id - Update a task's configuration; name updates are draft-only
 * - PUT /api/tasks/:id - Update a draft task's configuration
 * - DELETE /api/tasks/:id - Delete a task
 * - GET /api/tasks/:id/comments - Get all review comments for a task
 */

import { tasksCollectionRoutes } from "./collection";
import { tasksItemRoutes } from "./item";
import { tasksCommentsRoutes } from "./comments";

export { tasksCollectionRoutes } from "./collection";
export { tasksItemRoutes } from "./item";
export { tasksCommentsRoutes } from "./comments";

export const tasksCrudRoutes = defineRoutes({
  ...tasksCollectionRoutes,
  ...tasksItemRoutes,
  ...tasksCommentsRoutes,
});
