import type { TaskCtx } from "./context";
import { loadTask } from "../../persistence/tasks";
import { getReviewComments as getReviewCommentsFromDb } from "../../persistence/review-comments";

export async function getReviewHistoryImpl(
  _ctx: TaskCtx,
  taskId: string
): Promise<{ success: boolean; error?: string; history?: {
  addressable: boolean;
  completionAction: "local" | "push";
  reviewCycles: number;
} }> {
  const task = await loadTask(taskId);
  if (!task) {
    return { success: false, error: "Task not found" };
  }

  if (!task.state.reviewMode) {
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
      addressable: task.state.reviewMode.addressable,
      completionAction: task.state.reviewMode.completionAction,
      reviewCycles: task.state.reviewMode.reviewCycles,
    },
  };
}

export function getReviewCommentsImpl(
  _ctx: TaskCtx,
  taskId: string
): Array<{
  id: string;
  taskId: string;
  reviewCycle: number;
  commentText: string;
  createdAt: string;
  status: "pending" | "addressed";
  addressedAt?: string;
}> {
  const dbComments = getReviewCommentsFromDb(taskId);
  return dbComments.map((c) => ({
    id: c.id,
    taskId: c.task_id,
    reviewCycle: c.review_cycle,
    commentText: c.comment_text,
    createdAt: c.created_at,
    status: c.status as "pending" | "addressed",
    addressedAt: c.addressed_at ?? undefined,
  }));
}
