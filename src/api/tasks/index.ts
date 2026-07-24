/**
 * Tasks API endpoints for Clanky Tasks Management System.
 *
 * This module provides comprehensive CRUD operations and lifecycle control for Clanky Tasks:
 * - CRUD: Create, read, update, and delete tasks
 * - Control: Accept, push, discard, and purge completed tasks
 * - Plan Mode: Create, review, and accept plans before execution
 * - SSH: Task-linked SSH session management
 * - SSH: Task-linked persistent SSH sessions
 * - Review: Address reviewer comments on pushed/merged tasks
 * - Data: Access task diffs, plans, status files, and PR navigation metadata
 *
 * Uses the CommandExecutor abstraction over the configured execution channel:
 * - local provider: commands run on the Clanky host
 * - ssh provider: commands run on the remote workspace host
 *
 * @module api/tasks
 */

import { defineRoutes } from "@pablozaiden/webapp/server";

export { tasksCrudRoutes } from "./crud";
export { tasksDataRoutes } from "./data";
export { tasksReviewRoutes } from "./review";
export { tasksDraftRoutes } from "./draft";
export { tasksAcceptPushRoutes } from "./accept-push";
export { tasksDiscardPurgeRoutes } from "./discard-purge";
export { tasksSshSessionRoutes } from "./ssh-session";
export { tasksPendingRoutes } from "./pending";
export { tasksPlanRoutes } from "./plan";
export { tasksStopRoutes } from "./stop";
export { tasksChatRoutes } from "./chat";
export { tasksTranscriptRoutes } from "./transcript";

import { tasksCrudRoutes } from "./crud";
import { tasksDraftRoutes } from "./draft";
import { tasksAcceptPushRoutes } from "./accept-push";
import { tasksDiscardPurgeRoutes } from "./discard-purge";
import { tasksSshSessionRoutes } from "./ssh-session";
import { tasksPendingRoutes } from "./pending";
import { tasksPlanRoutes } from "./plan";
import { tasksDataRoutes } from "./data";
import { tasksReviewRoutes } from "./review";
import { tasksStopRoutes } from "./stop";
import { tasksChatRoutes } from "./chat";
import { tasksTranscriptRoutes } from "./transcript";

/**
 * All tasks routes combined.
 */
export const tasksRoutes = defineRoutes({
  ...tasksCrudRoutes,
  ...tasksDraftRoutes,
  ...tasksAcceptPushRoutes,
  ...tasksDiscardPurgeRoutes,
  ...tasksSshSessionRoutes,
  ...tasksPendingRoutes,
  ...tasksPlanRoutes,
  ...tasksDataRoutes,
  ...tasksReviewRoutes,
  ...tasksStopRoutes,
  ...tasksChatRoutes,
  ...tasksTranscriptRoutes,
});
