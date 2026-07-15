/**
 * Shared context passed to all TaskManager sub-module functions.
 */
import type { TaskEngine } from "../task-engine";
import type { SimpleEventEmitter } from "../event-emitter";
import type { TaskEvent } from "@/shared/events";
import type { Task, ModelConfig } from "@/shared/task";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { GitService } from "../git";
import type { CommandExecutor } from "../command-executor";
import type { SendFollowUpResult, TaskResult } from "./task-types";
import type { AcceptPlanResult, AcceptPlanOptions } from "./task-types";
import type { AutomaticPrFlowState } from "@/shared/task";
import type { PushTaskResult } from "./task-types";

export interface TaskCtx {
  engines: Map<string, TaskEngine>;
  emitter: SimpleEventEmitter<TaskEvent>;
  tasksBeingAccepted: Set<string>;
  // Cross-module callbacks (bound in TaskManager constructor)
  stopTask(taskId: string, reason?: string): Promise<void>;
  deleteTask(taskId: string): Promise<boolean>;
  discardTask(taskId: string): Promise<TaskResult>;
  getTask(taskId: string): Promise<Task | null>;
  startTask(taskId: string, options?: { attachments?: MessageImageAttachment[] }): Promise<void>;
  startPlanMode(taskId: string, options?: { attachments?: MessageImageAttachment[] }): Promise<void>;
  acceptPlan(taskId: string, options?: AcceptPlanOptions): Promise<AcceptPlanResult>;
  pushTask(taskId: string): Promise<PushTaskResult>;
  startAutomaticPrFlow(
    taskId: string,
  ): Promise<TaskResult<{ automaticPrFlow?: AutomaticPrFlowState }>>;
  startStatePersistence(taskId: string): void;
  ensureTaskBranchCheckedOut(task: Task, git: GitService, workingDirectory: string): Promise<void>;
  validateMainCheckoutStart(task: Task, git: GitService): Promise<void>;
  clearPlanningFiles(taskId: string, task: Task, executor: CommandExecutor, worktreePath: string): Promise<void>;
  recoverPlanningEngine(taskId: string): Promise<TaskEngine>;
  startFeedbackCycle(
    taskId: string,
    options: { prompt: string; model?: ModelConfig; reviewCommentText?: string; attachments?: MessageImageAttachment[] },
  ): Promise<SendFollowUpResult>;
  jumpstartTask(taskId: string, options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }): Promise<TaskResult>;
}
