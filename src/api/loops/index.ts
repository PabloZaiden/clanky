/**
 * Loops API endpoints for Ralph Loops Management System.
 *
 * This module provides comprehensive CRUD operations and lifecycle control for Ralph Loops:
 * - CRUD: Create, read, update, and delete loops
 * - Control: Accept, push, discard, and purge completed loops
 * - Plan Mode: Create, review, and accept plans before execution
 * - SSH: Loop-linked SSH session management
 * - Port Forwards: Loop-scoped remote service exposure
 * - Review: Address reviewer comments on pushed/merged loops
 * - Data: Access loop diffs, plans, status files, and PR navigation metadata
 *
 * Uses the CommandExecutor abstraction over the configured execution channel:
 * - local provider: commands run on the Ralpher host
 * - ssh provider: commands run on the remote workspace host
 *
 * @module api/loops
 */

export { loopsCrudRoutes } from "./crud";
export { loopsControlRoutes } from "./lifecycle";
export { loopsDataRoutes } from "./data";
export { loopsReviewRoutes } from "./review";
export { loopsDraftRoutes } from "./draft";
export { loopsAcceptPushRoutes } from "./accept-push";
export { loopsDiscardPurgeRoutes } from "./discard-purge";
export { loopsSshPortsRoutes } from "./ssh-ports";
export { loopsPendingRoutes } from "./pending";
export { loopsPlanRoutes } from "./plan";
export { loopsStopRoutes } from "./stop";

import { loopsCrudRoutes } from "./crud";
import { loopsDraftRoutes } from "./draft";
import { loopsAcceptPushRoutes } from "./accept-push";
import { loopsDiscardPurgeRoutes } from "./discard-purge";
import { loopsSshPortsRoutes } from "./ssh-ports";
import { loopsPendingRoutes } from "./pending";
import { loopsPlanRoutes } from "./plan";
import { loopsDataRoutes } from "./data";
import { loopsReviewRoutes } from "./review";
import { loopsStopRoutes } from "./stop";

/**
 * All loops routes combined.
 */
export const loopsRoutes = {
  ...loopsCrudRoutes,
  ...loopsDraftRoutes,
  ...loopsAcceptPushRoutes,
  ...loopsDiscardPurgeRoutes,
  ...loopsSshPortsRoutes,
  ...loopsPendingRoutes,
  ...loopsPlanRoutes,
  ...loopsDataRoutes,
  ...loopsReviewRoutes,
  ...loopsStopRoutes,
};
