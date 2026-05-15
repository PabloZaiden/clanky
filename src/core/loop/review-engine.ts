import type { LoopCtx } from "./context";
import type { Loop, ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import { LoopEngine } from "../loop-engine";
import { insertReviewComment, } from "../../persistence/review-comments";
import { backendManager } from "../backend-manager";
import { GitService } from "../git-service";
import { log } from "../logger";
import { assertValidTransition } from "../loop-state-machine";
import { saveLoop, updateLoopState } from "../../persistence/loops";
import { startStatePersistenceImpl } from "./loop-execution";

export async function transitionToFeedbackCycleAndStart(
  ctx: LoopCtx,
  loopId: string,
  loop: Loop,
  backend: ReturnType<typeof backendManager.getLoopBackend>,
  git: GitService,
  options: {
    prompt: string;
    model?: ModelConfig;
    transitionLabel: string;
    reviewComment?: {
      id: string;
      text: string;
    };
    nextReviewCycle: number;
    resultBranch: string;
    attachments?: MessageImageAttachment[];
  },
): Promise<{ success: boolean; reviewCycle: number; branch: string; commentIds?: string[] }> {
  assertValidTransition(loop.state.status, "idle", `startFeedbackCycle:${options.transitionLabel}`);
  loop.state.status = "idle";
  loop.state.completedAt = undefined;
  loop.state.error = undefined;
  loop.state.syncState = undefined;
  loop.state.pendingPrompt = undefined;
  loop.state.pendingModel = undefined;
  if (options.model !== undefined) {
    loop.config.model = options.model;
  }

  await saveLoop(loop);

  if (options.reviewComment) {
    insertReviewComment({
      id: options.reviewComment.id,
      loopId,
      reviewCycle: options.nextReviewCycle,
      commentText: options.reviewComment.text,
      createdAt: new Date().toISOString(),
      status: "pending",
    });
  }

  startFeedbackEngine(ctx, loopId, loop, backend, git, {
    prompt: options.prompt,
    model: options.model,
    startFailureLabel: options.reviewComment ? "addressing comments" : "sending follow-up feedback",
    attachments: options.attachments,
  });

  return {
    success: true,
    reviewCycle: loop.state.reviewMode!.reviewCycles,
    branch: options.resultBranch,
    commentIds: options.reviewComment ? [options.reviewComment.id] : undefined,
  };
}

function startFeedbackEngine(
  ctx: LoopCtx,
  loopId: string,
  loop: Loop,
  backend: ReturnType<typeof backendManager.getLoopBackend>,
  git: GitService,
  options: {
    prompt: string;
    model?: ModelConfig;
    startFailureLabel: string;
    attachments?: MessageImageAttachment[];
  },
): void {
  const engine = new LoopEngine({
    loop: { config: loop.config, state: loop.state },
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state) => {
      await updateLoopState(loopId, state);
    },
    skipGitSetup: true,
    initialPromptAttachments: options.attachments,
  });
  ctx.engines.set(loopId, engine);

  if (options.model !== undefined) {
    engine.setPendingModel(options.model);
  }
  // Only set the prompt text — attachments are already provided via initialPromptAttachments
  // to avoid duplicating them (engine-prompt prefers pending over initial, which would
  // cause the initial copy to leak into a later prompt unexpectedly).
  engine.setPendingPrompt(options.prompt);

  startStatePersistenceImpl(ctx, loopId);

  // Fire-and-forget: the engine runs a long-lived process; errors are handled by the engine itself.
  engine.start().catch((error) => {
    log.error(`Loop ${loopId} failed to start after ${options.startFailureLabel}:`, String(error));
  });
}

export function constructReviewPrompt(comments: string): string {
  return `A reviewer has provided feedback on your previous work. Please address the following comments:

---
${comments}
---

Instructions:
- Read .ralph-planning/status.md to understand what was previously done
- **FIRST**: Immediately add each reviewer comment as a pending task in .ralph-planning/status.md before starting to address any of them. This ensures the feedback is tracked and preserved even if the conversation context is compacted.
- Make targeted changes to address each reviewer comment
- **IMPORTANT — Incremental progress tracking**: After addressing each individual reviewer comment, immediately update .ralph-planning/status.md to mark it as resolved and note what was changed. Do not batch updates — persist progress after each comment so it is preserved if the iteration is interrupted.
- Test your changes to ensure they work correctly
- When all comments are fully addressed, end your response with:

<promise>COMPLETE</promise>`;
}
