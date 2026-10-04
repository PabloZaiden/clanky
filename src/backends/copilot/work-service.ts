/**
 * Controls only tasks registered under an owned native conversation.
 */

import type { CopilotSession } from "@github/copilot-sdk";
import type { HarnessActivityStopResult, HarnessCleanupResult } from "@/shared/harness-control";
import { HarnessError } from "../harness-errors";

export async function stopCopilotActivity(session: CopilotSession, activityId: string): Promise<HarnessActivityStopResult> {
  const task = (await session.rpc.tasks.list()).tasks.find((entry) => entry.id === activityId);
  if (!task || task.type === "client") {
    throw new HarnessError("harness_activity_not_owned", "This native activity has no verified Clanky control scope.");
  }
  if (["cancelled", "completed", "failed"].includes(task.status)) return { status: "stopped", activityId };
  await session.rpc.tasks.cancel({ id: task.id });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await session.rpc.tasks.refresh();
    const observed = (await session.rpc.tasks.list()).tasks.find((entry) => entry.id === activityId);
    if (observed && ["cancelled", "completed", "failed"].includes(observed.status)) {
      return { status: "stopped", activityId };
    }
    if (!observed) return { status: "unknown", activityId };
    await Bun.sleep(100);
  }
  return { status: "stopping", activityId };
}

export async function settleCopilotWork(session: CopilotSession): Promise<HarnessCleanupResult> {
  if ((await session.rpc.metadata.isProcessing()).processing) await session.abort();
  const deadline = Date.now() + 15_000;
  let activityIds: string[] = [];
  do {
    await session.rpc.tasks.refresh();
    const listing = await session.rpc.tasks.list();
    const owned = listing.tasks.filter((task) => task.type !== "client" && ["running", "idle"].includes(task.status));
    for (const task of owned) await stopCopilotActivity(session, task.id);
    await session.rpc.tasks.refresh();
    const [remaining, processing] = await Promise.all([session.rpc.tasks.list(), session.rpc.metadata.isProcessing()]);
    activityIds = remaining.tasks.filter((task) => task.type !== "client" && ["running", "idle", "orphaned"].includes(task.status)).map((task) => task.id);
    if (processing.processing) activityIds.push(session.sessionId);
    if (activityIds.length === 0) return { status: "settled", observedAt: new Date().toISOString() };
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  return { status: "pending", activityIds };
}
