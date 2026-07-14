/**
 * Task manager for Clanky Tasks Management System.
 * Manages the lifecycle of Clanky Tasks: CRUD, start/stop, accept/discard.
 * This is the main entry point for task operations.
 *
 * The implementation is split across sub-modules; this file is the public facade.
 */

// Re-export all public types
export type { CreateTaskOptions, StartTaskOptions, GenerateTaskTitleOptions, AcceptPlanOptions, AcceptPlanResult, AcceptTaskResult, SendFollowUpResult, SendFollowUpOptions, PushTaskResult, SeedPlanFilesOptions } from "./task-types";
export { getTaskWorkingDirectory } from "./task-types";

import type { TaskCtx } from "./context";
import type { AutomaticPrFlowFeedbackSource, Task, TaskConfig, TaskState } from "@/shared/task";
import type { TaskEvent } from "@/shared/events";
import type { ModelConfig } from "@/shared/task";
import type { CreateTaskOptions, StartTaskOptions, GenerateTaskTitleOptions, AcceptPlanOptions, AcceptPlanResult, AcceptTaskResult, SendFollowUpResult, SendFollowUpOptions, PushTaskResult } from "./task-types";
import type { SeedPlanFilesOptions } from "./task-types";
import type { PullRequestDestinationResponse } from "@/contracts";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { AutomaticPrFlowExtractedFeedbackItem } from "../automatic-pr-feedback";

import { TaskEngine } from "../task-engine";
import { taskEventEmitter, SimpleEventEmitter } from "../event-emitter";

import { createTaskImpl, generateTaskTitleImpl, getTaskImpl, getAllTasksImpl, getTaskSummariesImpl, updateTaskImpl, getPullRequestDestinationImpl, saveLastUsedModelImpl, saveLastUsedCheapModelImpl, isRunningImpl, getRunningTaskStateImpl } from "./task-crud";
import { startTaskImpl, stopTaskImpl, startPlanModeImpl, startDraftImpl, recoverPlanningEngineImpl, startStatePersistenceImpl, validateMainCheckoutStartImpl, clearPlanningFilesImpl, ensureTaskBranchCheckedOutImpl } from "./task-execution";
import { sendPlanFeedbackImpl, acceptPlanImpl, discardPlanImpl } from "./task-plan-mode";
import { seedPlanFilesImpl } from "./task-seeded-plan";
import { deleteTaskImpl, discardTaskImpl, purgeTaskImpl, markMergedImpl, closeLocalTaskImpl, manualCompleteTaskImpl, shutdownImpl, forceResetAllImpl, resetForTestingImpl } from "./task-lifecycle";
import { acceptTaskImpl, pushTaskImpl, updateBranchImpl } from "./task-git";
import { setPendingPromptImpl, clearPendingPromptImpl, setPendingModelImpl, clearPendingModelImpl, clearPendingImpl, setPendingImpl, injectPendingImpl, sendFollowUpImpl, jumpstartTaskImpl } from "./task-pending";
import {
  addressReviewCommentsImpl,
  enablePullRequestAutoMergeImpl,
  getReviewHistoryImpl,
  getReviewCommentsImpl,
  startAutomaticPrReviewCycleImpl,
  startAutomaticPrFlowImpl,
  startFeedbackCycleImpl,
  stopAutomaticPrFlowImpl,
} from "./task-review";

export class TaskManager {
  private readonly ctx: TaskCtx;
  private readonly engines: Map<string, TaskEngine>;

  constructor(options?: { eventEmitter?: SimpleEventEmitter<TaskEvent> }) {
    this.engines = new Map<string, TaskEngine>();
    const emitter = options?.eventEmitter ?? taskEventEmitter;
    const tasksBeingAccepted = new Set<string>();

    this.ctx = {
      engines: this.engines,
      emitter,
      tasksBeingAccepted,
      stopTask: (id, reason) => this.stopTask(id, reason),
      deleteTask: (id) => this.deleteTask(id),
      discardTask: (id) => this.discardTask(id),
      getTask: (id) => this.getTask(id),
      startTask: (id, options) => this.startTask(id, options),
      startPlanMode: (id, options) => this.startPlanMode(id, options),
      acceptPlan: (id, options) => this.acceptPlan(id, options),
      pushTask: (id) => this.pushTask(id),
      startAutomaticPrFlow: (id) => this.startAutomaticPrFlow(id),
      startStatePersistence: (id) => startStatePersistenceImpl(this.ctx, id),
      ensureTaskBranchCheckedOut: (task, git, dir) => ensureTaskBranchCheckedOutImpl(this.ctx, task, git, dir),
      validateMainCheckoutStart: (task, git) => validateMainCheckoutStartImpl(this.ctx, task, git),
      clearPlanningFiles: (id, task, executor, path) => clearPlanningFilesImpl(this.ctx, id, task, executor, path),
      recoverPlanningEngine: (id) => this.recoverPlanningEngine(id),
      startFeedbackCycle: (id, opts) => startFeedbackCycleImpl(this.ctx, id, opts),
      jumpstartTask: (id, opts) => jumpstartTaskImpl(this.ctx, id, opts),
    };
  }

  async createTask(options: CreateTaskOptions): Promise<Task> {
    return createTaskImpl(this.ctx, options);
  }

  async generateTaskTitle(options: GenerateTaskTitleOptions): Promise<string> {
    return generateTaskTitleImpl(this.ctx, options);
  }

  async startPlanMode(taskId: string, options?: StartTaskOptions): Promise<void> {
    return startPlanModeImpl(this.ctx, taskId, options);
  }

  async startDraft(taskId: string, options: { planMode: boolean; attachments?: MessageImageAttachment[] }): Promise<Task> {
    return startDraftImpl(this.ctx, taskId, options);
  }

  async sendPlanFeedback(taskId: string, feedback: string, attachments?: MessageImageAttachment[]): Promise<void> {
    return sendPlanFeedbackImpl(this.ctx, taskId, feedback, attachments);
  }

  async acceptPlan(taskId: string, options: AcceptPlanOptions = {}): Promise<AcceptPlanResult> {
    return acceptPlanImpl(this.ctx, taskId, options);
  }

  async discardPlan(taskId: string): Promise<boolean> {
    return discardPlanImpl(this.ctx, taskId);
  }

  async seedPlanFiles(taskId: string, options: SeedPlanFilesOptions): Promise<Task> {
    return seedPlanFilesImpl(this.ctx, taskId, options);
  }

  async getTask(taskId: string): Promise<Task | null> {
    return getTaskImpl(this.ctx, taskId);
  }

  async getPullRequestDestination(taskId: string): Promise<PullRequestDestinationResponse | null> {
    return getPullRequestDestinationImpl(this.ctx, taskId);
  }

  async getAllTasks(): Promise<Task[]> {
    return getAllTasksImpl(this.ctx);
  }

  async getTaskSummaries(): Promise<Task[]> {
    return getTaskSummariesImpl(this.ctx);
  }

  async updateTask(
    taskId: string,
    updates: Partial<Omit<TaskConfig, "id" | "createdAt">>
  ): Promise<Task | null> {
    return updateTaskImpl(this.ctx, taskId, updates);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return deleteTaskImpl(this.ctx, taskId);
  }

  async startTask(taskId: string, _options?: StartTaskOptions): Promise<void> {
    return startTaskImpl(this.ctx, taskId, _options);
  }

  async stopTask(taskId: string, reason?: string): Promise<void> {
    return stopTaskImpl(this.ctx, taskId, reason);
  }

  async acceptTask(taskId: string): Promise<AcceptTaskResult> {
    return acceptTaskImpl(this.ctx, taskId);
  }

  async pushTask(taskId: string): Promise<PushTaskResult> {
    return pushTaskImpl(this.ctx, taskId);
  }

  async updateBranch(taskId: string): Promise<PushTaskResult> {
    return updateBranchImpl(this.ctx, taskId);
  }

  async discardTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    return discardTaskImpl(this.ctx, taskId);
  }

  async purgeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    return purgeTaskImpl(this.ctx, taskId);
  }

  async markMerged(taskId: string): Promise<{ success: boolean; error?: string }> {
    return markMergedImpl(this.ctx, taskId);
  }

  async closeLocalTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    return closeLocalTaskImpl(this.ctx, taskId);
  }

  async manualCompleteTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    return manualCompleteTaskImpl(this.ctx, taskId);
  }

  async setPendingPrompt(
    taskId: string,
    prompt: string,
    attachments?: MessageImageAttachment[],
  ): Promise<{ success: boolean; error?: string }> {
    return setPendingPromptImpl(this.ctx, taskId, prompt, attachments);
  }

  async clearPendingPrompt(taskId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingPromptImpl(this.ctx, taskId);
  }

  async setPendingModel(taskId: string, model: ModelConfig): Promise<{ success: boolean; error?: string }> {
    return setPendingModelImpl(this.ctx, taskId, model);
  }

  async clearPendingModel(taskId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingModelImpl(this.ctx, taskId);
  }

  async clearPending(taskId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingImpl(this.ctx, taskId);
  }

  async setPending(
    taskId: string,
    options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
  ): Promise<{ success: boolean; error?: string }> {
    return setPendingImpl(this.ctx, taskId, options);
  }

  async injectPending(
    taskId: string,
    options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
  ): Promise<{ success: boolean; error?: string }> {
    return injectPendingImpl(this.ctx, taskId, options);
  }

  async sendFollowUp(
    taskId: string,
    options: SendFollowUpOptions,
  ): Promise<SendFollowUpResult> {
    return sendFollowUpImpl(this.ctx, taskId, options);
  }

  async addressReviewComments(
    taskId: string,
    comments: string,
    attachments?: MessageImageAttachment[],
  ): Promise<{ success: boolean; error?: string; reviewCycle?: number; branch?: string; commentIds?: string[] }> {
    return addressReviewCommentsImpl(this.ctx, taskId, comments, attachments);
  }

  async startAutomaticPrReviewCycle(
    taskId: string,
    options: {
      batchId: string;
      sourceItems: Array<{
        id: string;
        source: AutomaticPrFlowFeedbackSource;
        body: string;
        authorLogin?: string;
        createdAt?: string;
        url?: string;
        threadId?: string;
        path?: string;
        line?: number;
      }>;
      feedbackItems: AutomaticPrFlowExtractedFeedbackItem[];
    },
  ): Promise<SendFollowUpResult> {
    return startAutomaticPrReviewCycleImpl(this.ctx, taskId, options);
  }

  async startAutomaticPrFlow(
    taskId: string,
  ): Promise<{ success: boolean; error?: string; automaticPrFlow?: Task["state"]["automaticPrFlow"] }> {
    return startAutomaticPrFlowImpl(this.ctx, taskId);
  }

  async stopAutomaticPrFlow(
    taskId: string,
  ): Promise<{ success: boolean; error?: string; automaticPrFlow?: Task["state"]["automaticPrFlow"] }> {
    return stopAutomaticPrFlowImpl(this.ctx, taskId);
  }

  async enablePullRequestAutoMerge(
    taskId: string,
  ): Promise<{ success: boolean; error?: string; pullRequest?: { number: number; url: string } }> {
    return enablePullRequestAutoMergeImpl(this.ctx, taskId);
  }

  async getReviewHistory(taskId: string): Promise<{ success: boolean; error?: string; history?: {
    addressable: boolean;
    completionAction: "local" | "push";
    reviewCycles: number;
  } }> {
    return getReviewHistoryImpl(this.ctx, taskId);
  }

  getReviewComments(taskId: string): Array<{
    id: string;
    taskId: string;
    reviewCycle: number;
    commentText: string;
    createdAt: string;
    status: "pending" | "addressed";
    addressedAt?: string;
  }> {
    return getReviewCommentsImpl(this.ctx, taskId);
  }

  async saveLastUsedModel(model: {
    providerID: string;
    modelID: string;
    variant?: string;
  }): Promise<void> {
    return saveLastUsedModelImpl(this.ctx, model);
  }

  async saveLastUsedCheapModel(selection: NonNullable<TaskConfig["cheapModel"]>): Promise<void> {
    return saveLastUsedCheapModelImpl(this.ctx, selection);
  }

  isRunning(taskId: string): boolean {
    return isRunningImpl(this.ctx, taskId);
  }

  getRunningTaskState(taskId: string): TaskState | null {
    return getRunningTaskStateImpl(this.ctx, taskId);
  }

  async shutdown(): Promise<void> {
    return shutdownImpl(this.ctx);
  }

  async forceResetAll(): Promise<{ enginesCleared: number; tasksReset: number }> {
    return forceResetAllImpl(this.ctx);
  }

  resetForTesting(): void {
    return resetForTestingImpl(this.ctx);
  }

  private async recoverPlanningEngine(taskId: string): Promise<TaskEngine> {
    return recoverPlanningEngineImpl(this.ctx, taskId);
  }
}

/**
 * Singleton instance of TaskManager.
 */
export const taskManager = new TaskManager();
