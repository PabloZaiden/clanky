import type { TaskCtx } from "./context";
import type { Task, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { TaskEngine } from "../task-engine";
import { insertReviewComment, } from "../../persistence/review-comments";
import { backendManager } from "../backend-manager";
import { GitService } from "../git";
import { log } from "@pablozaiden/webapp/server";
import { assertValidTransition } from "../task-state-machine";
import {
  updateTaskConfig,
  updateTaskOperationalState,
  updateTaskState,
} from "../../persistence/tasks";
import { startStatePersistenceImpl } from "./task-execution";

export async function transitionToFeedbackCycleAndStart(
  ctx: TaskCtx,
  taskId: string,
  task: Task,
  backend: ReturnType<typeof backendManager.getTaskBackend>,
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
): Promise<{ success: true; reviewCycle: number; branch: string; commentIds?: string[] }> {
  assertValidTransition(task.state.status, "idle", `startFeedbackCycle:${options.transitionLabel}`);
  task.state.status = "idle";
  task.state.completedAt = undefined;
  task.state.error = undefined;
  task.state.syncState = undefined;
  task.state.pendingPrompt = undefined;
  task.state.pendingModel = undefined;
  if (options.model !== undefined) {
    task.config.model = options.model;
  }

  await updateTaskOperationalState(taskId, task.state);
  if (options.model !== undefined) {
    await updateTaskConfig(taskId, task.config);
  }

  if (options.reviewComment) {
    insertReviewComment({
      id: options.reviewComment.id,
      taskId,
      reviewCycle: options.nextReviewCycle,
      commentText: options.reviewComment.text,
      createdAt: new Date().toISOString(),
      status: "pending",
    });
  }

  startFeedbackEngine(ctx, taskId, task, backend, git, {
    prompt: options.prompt,
    model: options.model,
    startFailureLabel: options.reviewComment ? "addressing comments" : "sending follow-up feedback",
    attachments: options.attachments,
  });

  return {
    success: true,
    reviewCycle: task.state.reviewMode!.reviewCycles,
    branch: options.resultBranch,
    commentIds: options.reviewComment ? [options.reviewComment.id] : undefined,
  };
}

function startFeedbackEngine(
  ctx: TaskCtx,
  taskId: string,
  task: Task,
  backend: ReturnType<typeof backendManager.getTaskBackend>,
  git: GitService,
  options: {
    prompt: string;
    model?: ModelConfig;
    startFailureLabel: string;
    attachments?: MessageImageAttachment[];
  },
): void {
  const engine = new TaskEngine({
    task: { config: task.config, state: task.state },
    backend,
    gitService: git,
    eventEmitter: ctx.emitter,
    onPersistState: async (state, options) => {
      await updateTaskState(taskId, state, options);
    },
    skipGitSetup: true,
    initialPromptAttachments: options.attachments,
  });
  ctx.engines.set(taskId, engine);

  if (options.model !== undefined) {
    engine.setPendingModel(options.model);
  }
  // Only set the prompt text — attachments are already provided via initialPromptAttachments
  // to avoid duplicating them (engine-prompt prefers pending over initial, which would
  // cause the initial copy to leak into a later prompt unexpectedly).
  engine.setPendingPrompt(options.prompt);

  startStatePersistenceImpl(ctx, taskId);

  // Fire-and-forget: the engine runs a long-lived process; errors are handled by the engine itself.
  engine.start().catch((error) => {
    log.error(`Task ${taskId} failed to start after ${options.startFailureLabel}:`, String(error));
  });
}

export function constructReviewPrompt(comments: string): string {
  return `A reviewer has provided feedback on your previous work. Please address the following comments:

---
${comments}
---

Instructions:
- Read .clanky-planning/status.md to understand what was previously done
- **FIRST**: Immediately add each reviewer comment as a pending task in .clanky-planning/status.md before starting to address any of them. This ensures the feedback is tracked and preserved even if the conversation context is compacted.
- Make targeted changes to address each reviewer comment
- **IMPORTANT — Incremental progress tracking**: After addressing each individual reviewer comment, immediately update .clanky-planning/status.md to mark it as resolved and note what was changed. Do not batch updates — persist progress after each comment so it is preserved if the iteration is interrupted.
- Test your changes to ensure they work correctly
- When all comments are fully addressed, end your response with:

<promise>COMPLETE</promise>`;
}
