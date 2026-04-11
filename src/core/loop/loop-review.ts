import type { LoopCtx } from "./context";
import type { Loop, ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { SendFollowUpResult } from "./loop-types";
import type { AutomaticPrFlowFeedbackItem } from "../automatic-pr-flow-github";
import { loadLoop, saveLoop } from "../../persistence/loops";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { getLoopWorkingDirectory } from "./loop-types";
import { constructReviewPrompt, setupMergedReviewWorktree, transitionToFeedbackCycleAndStart } from "./review-engine";
import { ensureAutomaticPrFlowPullRequest } from "../automatic-pr-flow-github";
export { getReviewHistoryImpl } from "./review-history";
export { getReviewCommentsImpl } from "./review-history";

export async function addressReviewCommentsImpl(
  ctx: LoopCtx,
  loopId: string,
  comments: string,
  attachments: MessageImageAttachment[] = [],
): Promise<{ success: boolean; error?: string; reviewCycle?: number; branch?: string; commentIds?: string[] }> {
  if (!comments || comments.trim() === "") {
    return { success: false, error: "Comments cannot be empty" };
  }

  return startFeedbackCycleImpl(ctx, loopId, {
    prompt: constructReviewPrompt(comments.trim()),
    reviewCommentText: comments.trim(),
    attachments,
  });
}

export function constructAutomaticPrReviewPrompt(feedbackItems: AutomaticPrFlowFeedbackItem[]): string {
  const normalizedItems = feedbackItems
    .map((item, index) => {
      const metadata = [
        `source=${item.source}`,
        item.authorLogin ? `author=${item.authorLogin}` : undefined,
        item.path ? `path=${item.path}${item.line !== undefined ? `:${item.line}` : ""}` : undefined,
        item.url ? `url=${item.url}` : undefined,
      ].filter(Boolean).join(", ");

      return [
        `Feedback ${index + 1}${metadata ? ` (${metadata})` : ""}:`,
        item.body.trim(),
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return `A pull request has received new reviewer feedback. Evaluate each item carefully and decide whether a code or test change is needed.

Feedback items:

${normalizedItems}

Instructions:
- Read AGENTS.md and .ralph-planning/status.md to understand the existing context.
- Treat each feedback item independently and make only the changes that are actually needed.
- If a feedback item does not require a code change, do not force one just to satisfy the comment.
- Update .ralph-planning/status.md incrementally as you work through the feedback.
- Run the relevant build/tests before finishing.
- When all actionable items are handled, end your response with:

<promise>COMPLETE</promise>`;
}

export async function startAutomaticPrReviewCycleImpl(
  ctx: LoopCtx,
  loopId: string,
  options: {
    batchId: string;
    itemIds: string[];
    feedbackItems: AutomaticPrFlowFeedbackItem[];
  },
): Promise<SendFollowUpResult> {
  if (options.itemIds.length === 0 || options.feedbackItems.length === 0) {
    return { success: false, error: "Automatic PR review cycle requires at least one feedback item." };
  }

  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  const automaticPrFlowState = loop.state.automaticPrFlow;
  if (!automaticPrFlowState?.enabled) {
    return { success: false, error: "Automatic PR flow is not enabled for this loop." };
  }

  if (loop.state.status !== "pushed") {
    return { success: false, error: `Cannot start automatic PR review cycle for loop in status: ${loop.state.status}` };
  }

  if (automaticPrFlowState.activeBatch) {
    return { success: false, error: "Automatic PR flow is already processing feedback." };
  }

  const now = new Date().toISOString();
  loop.state.automaticPrFlow = {
    ...automaticPrFlowState,
    status: "processing_feedback",
    updatedAt: now,
    lastCheckedAt: now,
    lastError: undefined,
    activeBatch: {
      batchId: options.batchId,
      itemIds: options.itemIds,
      items: options.feedbackItems.map((item) => ({
        id: item.id,
        source: item.source,
        threadId: item.threadId,
      })),
      startedAt: now,
    },
  };
  await saveLoop(loop);

  const result = await startFeedbackCycleImpl(ctx, loopId, {
    prompt: constructAutomaticPrReviewPrompt(options.feedbackItems),
  });
  if (result.success) {
    if (result.reviewCycle !== undefined) {
      const latestLoop = await loadLoop(loopId);
      if (latestLoop?.state.automaticPrFlow?.activeBatch?.batchId === options.batchId) {
        latestLoop.state.automaticPrFlow = {
          ...latestLoop.state.automaticPrFlow,
          activeBatch: {
            ...latestLoop.state.automaticPrFlow.activeBatch,
            reviewCycle: result.reviewCycle,
          },
          updatedAt: new Date().toISOString(),
        };
        await saveLoop(latestLoop);
      }
    }
    return result;
  }

  const rollbackLoop = await loadLoop(loopId);
  if (rollbackLoop?.state.automaticPrFlow?.activeBatch?.batchId === options.batchId) {
    rollbackLoop.state.automaticPrFlow = {
      ...rollbackLoop.state.automaticPrFlow,
      status: "error",
      updatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastError: result.error ?? "Automatic PR review cycle failed to start.",
      activeBatch: undefined,
    };
    await saveLoop(rollbackLoop);
  }

  return result;
}

export async function startAutomaticPrFlowImpl(
  _ctx: LoopCtx,
  loopId: string,
): Promise<{ success: boolean; error?: string; automaticPrFlow?: Loop["state"]["automaticPrFlow"] }> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (loop.state.status !== "pushed" || loop.state.reviewMode?.addressable !== true) {
    return {
      success: false,
      error: "Automatic PR flow only works for pushed loops that can receive review feedback.",
    };
  }

  const workingDirectory = getLoopWorkingDirectory(loop);
  if (!workingDirectory) {
    return {
      success: false,
      error: "Loop is configured to use a worktree, but no worktree path is available.",
    };
  }

  const existingState = loop.state.automaticPrFlow;
  if (existingState?.enabled) {
    return { success: true, automaticPrFlow: existingState };
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, workingDirectory);
    const git = GitService.withExecutor(executor);
    const pullRequest = await ensureAutomaticPrFlowPullRequest(loop, workingDirectory, executor, git);
    const now = new Date().toISOString();

    loop.state.automaticPrFlow = {
      enabled: true,
      status: "monitoring",
      startedAt: now,
      updatedAt: now,
      lastCheckedAt: now,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      handledItems: existingState?.handledItems ?? [],
      lastError: undefined,
      activeBatch: undefined,
      stoppedAt: undefined,
    };
    await saveLoop(loop);

    return { success: true, automaticPrFlow: loop.state.automaticPrFlow };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function stopAutomaticPrFlowImpl(
  _ctx: LoopCtx,
  loopId: string,
): Promise<{ success: boolean; error?: string; automaticPrFlow?: Loop["state"]["automaticPrFlow"] }> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  const existingState = loop.state.automaticPrFlow;
  const now = new Date().toISOString();
  loop.state.automaticPrFlow = existingState
    ? {
        ...existingState,
        enabled: false,
        status: "stopped",
        updatedAt: now,
        lastCheckedAt: now,
        lastError: undefined,
        activeBatch: undefined,
        stoppedAt: now,
      }
    : {
        enabled: false,
        status: "stopped",
        startedAt: now,
        updatedAt: now,
        lastCheckedAt: now,
        handledItems: [],
        activeBatch: undefined,
        stoppedAt: now,
      };
  await saveLoop(loop);

  return { success: true, automaticPrFlow: loop.state.automaticPrFlow };
}

export async function startFeedbackCycleImpl(
  ctx: LoopCtx,
  loopId: string,
  options: {
    prompt: string;
    model?: ModelConfig;
    reviewCommentText?: string;
    attachments?: MessageImageAttachment[];
  }
): Promise<SendFollowUpResult> {
  const loop = await loadLoop(loopId);
  if (!loop) {
    return { success: false, error: "Loop not found" };
  }

  if (!loop.state.reviewMode?.addressable) {
    return { success: false, error: "Loop is not addressable. Only pushed or merged loops can receive follow-up feedback." };
  }

  if (loop.state.status !== "pushed" && loop.state.status !== "merged") {
    return { success: false, error: `Cannot send follow-up on loop with status: ${loop.state.status}` };
  }

  if (ctx.engines.has(loopId)) {
    return { success: false, error: "Loop is already running" };
  }

  try {
    const executor = await backendManager.getCommandExecutorAsync(loop.config.workspaceId, loop.config.directory);
    const git = GitService.withExecutor(executor);
    const backend = backendManager.getLoopBackend(loopId, loop.config.workspaceId);
    const nextReviewCycle = loop.state.reviewMode.reviewCycles + 1;
    const reviewComment = options.reviewCommentText
      ? {
          id: crypto.randomUUID(),
          text: options.reviewCommentText,
        }
      : undefined;

    if (loop.state.reviewMode.completionAction === "push") {
      if (!loop.state.git?.workingBranch) {
        return { success: false, error: "No working branch found for pushed loop" };
      }

      loop.state.reviewMode.reviewCycles += 1;

      return transitionToFeedbackCycleAndStart(ctx, loopId, loop, backend, git, {
        prompt: options.prompt,
        model: options.model,
        transitionLabel: "pushed",
        reviewComment,
        nextReviewCycle,
        resultBranch: loop.state.git.workingBranch,
        attachments: options.attachments,
      });
    }

    if (!loop.state.git?.originalBranch) {
      return { success: false, error: "No original branch found for merged loop" };
    }

    loop.state.reviewMode.reviewCycles += 1;
    const reviewBranchName = await setupMergedReviewWorktree(loop, git);

    return transitionToFeedbackCycleAndStart(ctx, loopId, loop, backend, git, {
      prompt: options.prompt,
      model: options.model,
      transitionLabel: "merged",
      reviewComment,
      nextReviewCycle,
      resultBranch: reviewBranchName,
      attachments: options.attachments,
    });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
