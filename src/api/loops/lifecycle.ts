/**
 * @deprecated Re-exports from focused route modules. Import directly from the individual files instead.
 *
 * This file is kept for backward compatibility. All routes have been split into:
 * - draft.ts           : POST /api/loops/:id/draft/start
 * - accept-push.ts     : accept, push, update-branch, mark-merged
 * - discard-purge.ts   : discard, purge
 * - ssh-ports.ts       : ssh-session, port-forwards
 * - pending.ts         : pending-prompt, pending, follow-up
 * - plan.ts            : plan/feedback, plan/accept, plan/discard
 */

import { loopsDraftRoutes } from "./draft";
import { loopsAcceptPushRoutes } from "./accept-push";
import { loopsDiscardPurgeRoutes } from "./discard-purge";
import { loopsSshPortsRoutes } from "./ssh-ports";
import { loopsPendingRoutes } from "./pending";
import { loopsPlanRoutes } from "./plan";

export const loopsControlRoutes = {
  ...loopsDraftRoutes,
  ...loopsAcceptPushRoutes,
  ...loopsDiscardPurgeRoutes,
  ...loopsSshPortsRoutes,
  ...loopsPendingRoutes,
  ...loopsPlanRoutes,
};
