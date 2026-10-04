/**
 * Classifies observed workspace writers without cancelling unowned work.
 */

import type { HarnessActivitySnapshot, HarnessGitSafety } from "@/shared/harness-control";
import { createTimestamp } from "@/shared/events";

export function getHarnessWorkspaceSafety(activity: HarnessActivitySnapshot): HarnessGitSafety {
  if (activity.observation !== "available" || activity.coverage !== "native") {
    return { status: "blocked", reason: "unavailable", activityIds: [] };
  }
  const writers = activity.activities.filter((entry) =>
    entry.workspaceWrites !== "none"
    && ["queued", "running", "waiting", "stopping", "unknown"].includes(entry.status),
  );
  if (activity.principalProcessing || writers.length > 0) {
    return { status: "blocked", reason: "active-writers", activityIds: writers.map((entry) => entry.id) };
  }
  return { status: "safe", observedAt: createTimestamp() };
}
