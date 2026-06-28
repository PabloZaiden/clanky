/**
 * @deprecated Re-exports from focused route modules. Import directly from the individual files instead.
 *
 * This file is kept for backward compatibility. All routes have been split into:
 * - draft.ts           : POST /api/tasks/:id/draft/start
 * - accept-push.ts     : accept, push, update-branch, mark-merged
 * - discard-purge.ts   : discard, purge
 * - ssh-ports.ts       : ssh-session
 * - pending.ts         : pending-prompt, pending, follow-up
 * - plan.ts            : plan/feedback, plan/accept, plan/discard
 */

import { tasksDraftRoutes } from "./draft";
import { tasksAcceptPushRoutes } from "./accept-push";
import { tasksDiscardPurgeRoutes } from "./discard-purge";
import { tasksSshPortsRoutes } from "./ssh-ports";
import { tasksPendingRoutes } from "./pending";
import { tasksPlanRoutes } from "./plan";

export const tasksControlRoutes = {
  ...tasksDraftRoutes,
  ...tasksAcceptPushRoutes,
  ...tasksDiscardPurgeRoutes,
  ...tasksSshPortsRoutes,
  ...tasksPendingRoutes,
  ...tasksPlanRoutes,
};
