import type { TaskCtx } from "./context";
import type { Task, ModelConfig } from "@/shared/task";
import type { MessageAttachment } from "@/shared/message-attachments";
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
    attachments?: MessageAttachment[];
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
    attachments?: MessageAttachment[];
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
    reuseExistingSession: true,
    initialPromptAttachments: options.attachments,
  });
  ctx.engines.set(taskId, engine);

  if (options.model !== undefined) {
    engine.setPendingModel(options.model);
  }
  // Only set the prompt text — attachments are already provided via initialPromptAttachments
  // to avoid duplicating them (engine-prompt prefers pending over initial, which would
  // cause the initial copy to leak into a later prompt unexpectedly).
  engine.setPendingPrompt(options.prompt, [], "engine_context");

  startStatePersistenceImpl(ctx, taskId);

  // Fire-and-forget: the engine runs a long-lived process; errors are handled by the engine itself.
  engine.start().catch((error) => {
    log.error(`Task ${taskId} failed to start after ${options.startFailureLabel}:`, String(error));
  });
}

export function constructReviewPrompt(comments: string): string {
  return `The user has provided feedback on your previous work:

---
${comments}
---

When addressed, end your response with:

<promise>COMPLETE</promise>`;
}
