/**
 * Autonomous iterations do not compete with native continuations or owned work.
 */

import type { HarnessControl } from "@/shared/harness-control";
import { HarnessError } from "../backends/harness-errors";

export async function waitForHarnessQuiescence(control: HarnessControl, sessionId: string, shouldStop: () => boolean): Promise<void> {
  if (control.capabilities.adapter === "acp") return;
  while (!shouldStop()) {
    const activity = await control.getActivity(sessionId);
    if (activity.observation !== "available" || activity.coverage !== "native") {
      throw new HarnessError("harness_event_gap", "Native continuation state cannot be established.");
    }
    const activeOwnedWork = activity.activities.some((entry) =>
      entry.ownership === "owned" && ["queued", "running", "waiting", "stopping", "unknown"].includes(entry.status),
    );
    if (!activity.principalProcessing && !activeOwnedWork) return;
    await Bun.sleep(250);
  }
  throw new HarnessError("harness_connection_aborted", "Native continuation wait was interrupted.");
}
