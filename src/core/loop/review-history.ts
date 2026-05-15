import type { LoopCtx } from "./context";
import { loadLoop } from "../../persistence/loops";
import { getReviewComments as getReviewCommentsFromDb } from "../../persistence/review-comments";

export async function getReviewHistoryImpl(
  _ctx: LoopCtx,
  loopId: string
): Promise<{ success: boolean; error?: string; history?: {
  addressable: boolean;
  completionAction: "local" | "push";
  reviewCycles: number;
} }> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (!loop.state.reviewMode) {
    return {
      success: true,
      history: {
        addressable: false,
        completionAction: "local",
        reviewCycles: 0,
      },
    };
  }

  return {
    success: true,
    history: {
      addressable: loop.state.reviewMode.addressable,
      completionAction: loop.state.reviewMode.completionAction,
      reviewCycles: loop.state.reviewMode.reviewCycles,
    },
  };
}

export function getReviewCommentsImpl(
  _ctx: LoopCtx,
  loopId: string
): Array<{
  id: string;
  loopId: string;
  reviewCycle: number;
  commentText: string;
  createdAt: string;
  status: "pending" | "addressed";
  addressedAt?: string;
}> {
  const dbComments = getReviewCommentsFromDb(loopId);
  return dbComments.map((c) => ({
    id: c.id,
    loopId: c.loop_id,
    reviewCycle: c.review_cycle,
    commentText: c.comment_text,
    createdAt: c.created_at,
    status: c.status as "pending" | "addressed",
    addressedAt: c.addressed_at ?? undefined,
  }));
}
