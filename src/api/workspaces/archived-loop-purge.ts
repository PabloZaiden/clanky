/**
 * Shared helpers for purging loops in terminal states.
 */

import { loopManager } from "../../core/loop-manager";
import { isArchivedLoop } from "../../utils";

const ARCHIVED_LOOP_PURGE_CONCURRENCY = 4;

type LoopRecord = Awaited<ReturnType<typeof loopManager.getAllLoops>>[number];

export interface ArchivedLoopPurgeSummary {
  workspaceId: string;
  totalArchived: number;
  purgedCount: number;
  purgedLoopIds: string[];
  failures: Array<{ loopId: string; error: string }>;
}

type ArchivedLoopPurgeResult =
  | { success: true; loopId: string }
  | { success: false; loopId: string; error: string };

async function purgeArchivedLoopsWithConcurrency(
  archivedLoops: LoopRecord[],
): Promise<ArchivedLoopPurgeResult[]> {
  const results: ArchivedLoopPurgeResult[] = new Array(archivedLoops.length);
  let nextIndex = 0;

  const workerCount = Math.min(ARCHIVED_LOOP_PURGE_CONCURRENCY, archivedLoops.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < archivedLoops.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      const loop = archivedLoops[currentIndex]!;

      try {
        const result = await loopManager.purgeLoop(loop.config.id);
        if (result.success) {
          results[currentIndex] = { success: true, loopId: loop.config.id };
          continue;
        }

        results[currentIndex] = {
          success: false,
          loopId: loop.config.id,
          error: result.error ?? "Unknown error",
        };
      } catch (error) {
        results[currentIndex] = {
          success: false,
          loopId: loop.config.id,
          error: String(error),
        };
      }
    }
  });

  await Promise.allSettled(workers);
  return results;
}

export async function purgeArchivedWorkspaceLoops(
  workspaceId: string,
  loops?: LoopRecord[],
): Promise<ArchivedLoopPurgeSummary> {
  const allLoops = loops ?? await loopManager.getAllLoops();
  const archivedLoops = allLoops.filter(
    (loop) =>
      loop.config.workspaceId === workspaceId &&
      isArchivedLoop(loop.state.status, loop.state.reviewMode?.addressable),
  );

  const purgeResults = await purgeArchivedLoopsWithConcurrency(archivedLoops);
  const purgedLoopIds = purgeResults
    .filter((result): result is Extract<ArchivedLoopPurgeResult, { success: true }> => result.success)
    .map((result) => result.loopId);
  const failures = purgeResults
    .filter((result): result is Extract<ArchivedLoopPurgeResult, { success: false }> => !result.success)
    .map(({ loopId, error }) => ({ loopId, error }));

  return {
    workspaceId,
    totalArchived: archivedLoops.length,
    purgedCount: purgedLoopIds.length,
    purgedLoopIds,
    failures,
  };
}
