/**
 * Loop manager for Ralph Loops Management System.
 * Manages the lifecycle of Ralph Loops: CRUD, start/stop, accept/discard.
 * This is the main entry point for loop operations.
 *
 * The implementation is split across sub-modules; this file is the public facade.
 */

// Re-export all public types
export type { CreateLoopOptions, StartLoopOptions, AcceptPlanOptions, AcceptPlanResult, AcceptLoopResult, SendFollowUpResult, PushLoopResult } from "./loop-types";
export { getLoopWorkingDirectory } from "./loop-types";

import type { LoopCtx } from "./context";
import type { Loop, LoopConfig, LoopState } from "../../types/loop";
import type { LoopEvent } from "../../types/events";
import type { ModelConfig } from "../../types/loop";
import type { CreateLoopOptions, StartLoopOptions, AcceptPlanOptions, AcceptPlanResult, AcceptLoopResult, SendFollowUpResult, PushLoopResult } from "./loop-types";
import type { PullRequestDestinationResponse } from "../../types/api";
import type { MessageImageAttachment } from "../../types/message-attachments";

import { LoopEngine } from "../loop-engine";
import { loopEventEmitter, SimpleEventEmitter } from "../event-emitter";

import { createLoopImpl, generateLoopTitleImpl, getLoopImpl, getAllLoopsImpl, updateLoopImpl, getPullRequestDestinationImpl, saveLastUsedModelImpl, isRunningImpl, getRunningLoopStateImpl } from "./loop-crud";
import { startLoopImpl, stopLoopImpl, startPlanModeImpl, startDraftImpl, recoverPlanningEngineImpl, startStatePersistenceImpl, validateMainCheckoutStartImpl, clearPlanningFilesImpl, ensureLoopBranchCheckedOutImpl } from "./loop-execution";
import { sendPlanFeedbackImpl, answerPendingPlanQuestionImpl, acceptPlanImpl, discardPlanImpl } from "./loop-plan-mode";
import { deleteLoopImpl, discardLoopImpl, purgeLoopImpl, markMergedImpl, shutdownImpl, forceResetAllImpl, resetForTestingImpl } from "./loop-lifecycle";
import { acceptLoopImpl, pushLoopImpl, updateBranchImpl } from "./loop-git";
import { setPendingPromptImpl, clearPendingPromptImpl, setPendingModelImpl, clearPendingModelImpl, clearPendingImpl, setPendingImpl, injectPendingImpl, sendFollowUpImpl, jumpstartLoopImpl } from "./loop-pending";
import { addressReviewCommentsImpl, getReviewHistoryImpl, getReviewCommentsImpl, startFeedbackCycleImpl } from "./loop-review";

export class LoopManager {
  private readonly ctx: LoopCtx;
  private readonly engines: Map<string, LoopEngine>;

  constructor(options?: { eventEmitter?: SimpleEventEmitter<LoopEvent> }) {
    this.engines = new Map<string, LoopEngine>();
    const emitter = options?.eventEmitter ?? loopEventEmitter;
    const loopsBeingAccepted = new Set<string>();

    this.ctx = {
      engines: this.engines,
      emitter,
      loopsBeingAccepted,
      stopLoop: (id, reason) => this.stopLoop(id, reason),
      deleteLoop: (id) => this.deleteLoop(id),
      discardLoop: (id) => this.discardLoop(id),
      getLoop: (id) => this.getLoop(id),
      startLoop: (id, options) => this.startLoop(id, options),
      startPlanMode: (id, options) => this.startPlanMode(id, options),
      startStatePersistence: (id) => startStatePersistenceImpl(this.ctx, id),
      ensureLoopBranchCheckedOut: (loop, git, dir) => ensureLoopBranchCheckedOutImpl(this.ctx, loop, git, dir),
      validateMainCheckoutStart: (loop, git) => validateMainCheckoutStartImpl(this.ctx, loop, git),
      clearPlanningFiles: (id, loop, executor, path) => clearPlanningFilesImpl(this.ctx, id, loop, executor, path),
      recoverPlanningEngine: (id) => this.recoverPlanningEngine(id),
      startFeedbackCycle: (id, opts) => startFeedbackCycleImpl(this.ctx, id, opts),
      jumpstartLoop: (id, opts) => jumpstartLoopImpl(this.ctx, id, opts),
    };
  }

  async createLoop(options: CreateLoopOptions): Promise<Loop> {
    return createLoopImpl(this.ctx, options);
  }

  async generateLoopTitle(options: Pick<CreateLoopOptions, "prompt" | "directory" | "workspaceId">): Promise<string> {
    return generateLoopTitleImpl(this.ctx, options);
  }

  async startPlanMode(loopId: string, options?: StartLoopOptions): Promise<void> {
    return startPlanModeImpl(this.ctx, loopId, options);
  }

  async startDraft(loopId: string, options: { planMode: boolean; attachments?: MessageImageAttachment[] }): Promise<Loop> {
    return startDraftImpl(this.ctx, loopId, options);
  }

  async sendPlanFeedback(loopId: string, feedback: string, attachments?: MessageImageAttachment[]): Promise<void> {
    return sendPlanFeedbackImpl(this.ctx, loopId, feedback, attachments);
  }

  async answerPendingPlanQuestion(loopId: string, answers: string[][]): Promise<void> {
    return answerPendingPlanQuestionImpl(this.ctx, loopId, answers);
  }

  async acceptPlan(loopId: string, options: AcceptPlanOptions = {}): Promise<AcceptPlanResult> {
    return acceptPlanImpl(this.ctx, loopId, options);
  }

  async discardPlan(loopId: string): Promise<boolean> {
    return discardPlanImpl(this.ctx, loopId);
  }

  async getLoop(loopId: string): Promise<Loop | null> {
    return getLoopImpl(this.ctx, loopId);
  }

  async getPullRequestDestination(loopId: string): Promise<PullRequestDestinationResponse | null> {
    return getPullRequestDestinationImpl(this.ctx, loopId);
  }

  async getAllLoops(): Promise<Loop[]> {
    return getAllLoopsImpl(this.ctx);
  }

  async updateLoop(
    loopId: string,
    updates: Partial<Omit<LoopConfig, "id" | "createdAt">>
  ): Promise<Loop | null> {
    return updateLoopImpl(this.ctx, loopId, updates);
  }

  async deleteLoop(loopId: string): Promise<boolean> {
    return deleteLoopImpl(this.ctx, loopId);
  }

  async startLoop(loopId: string, _options?: StartLoopOptions): Promise<void> {
    return startLoopImpl(this.ctx, loopId, _options);
  }

  async stopLoop(loopId: string, reason?: string): Promise<void> {
    return stopLoopImpl(this.ctx, loopId, reason);
  }

  async acceptLoop(loopId: string): Promise<AcceptLoopResult> {
    return acceptLoopImpl(this.ctx, loopId);
  }

  async pushLoop(loopId: string): Promise<PushLoopResult> {
    return pushLoopImpl(this.ctx, loopId);
  }

  async updateBranch(loopId: string): Promise<PushLoopResult> {
    return updateBranchImpl(this.ctx, loopId);
  }

  async discardLoop(loopId: string): Promise<{ success: boolean; error?: string }> {
    return discardLoopImpl(this.ctx, loopId);
  }

  async purgeLoop(loopId: string): Promise<{ success: boolean; error?: string }> {
    return purgeLoopImpl(this.ctx, loopId);
  }

  async markMerged(loopId: string): Promise<{ success: boolean; error?: string }> {
    return markMergedImpl(this.ctx, loopId);
  }

  async setPendingPrompt(
    loopId: string,
    prompt: string,
    attachments?: MessageImageAttachment[],
  ): Promise<{ success: boolean; error?: string }> {
    return setPendingPromptImpl(this.ctx, loopId, prompt, attachments);
  }

  async clearPendingPrompt(loopId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingPromptImpl(this.ctx, loopId);
  }

  async setPendingModel(loopId: string, model: ModelConfig): Promise<{ success: boolean; error?: string }> {
    return setPendingModelImpl(this.ctx, loopId, model);
  }

  async clearPendingModel(loopId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingModelImpl(this.ctx, loopId);
  }

  async clearPending(loopId: string): Promise<{ success: boolean; error?: string }> {
    return clearPendingImpl(this.ctx, loopId);
  }

  async setPending(
    loopId: string,
    options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
  ): Promise<{ success: boolean; error?: string }> {
    return setPendingImpl(this.ctx, loopId, options);
  }

  async injectPending(
    loopId: string,
    options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
  ): Promise<{ success: boolean; error?: string }> {
    return injectPendingImpl(this.ctx, loopId, options);
  }

  async sendFollowUp(
    loopId: string,
    options: { message: string; model?: ModelConfig; attachments?: MessageImageAttachment[] },
  ): Promise<SendFollowUpResult> {
    return sendFollowUpImpl(this.ctx, loopId, options);
  }

  async addressReviewComments(
    loopId: string,
    comments: string,
    attachments?: MessageImageAttachment[],
  ): Promise<{ success: boolean; error?: string; reviewCycle?: number; branch?: string; commentIds?: string[] }> {
    return addressReviewCommentsImpl(this.ctx, loopId, comments, attachments);
  }

  async getReviewHistory(loopId: string): Promise<{ success: boolean; error?: string; history?: {
    addressable: boolean;
    completionAction: "push" | "merge";
    reviewCycles: number;
    reviewBranches: string[];
  } }> {
    return getReviewHistoryImpl(this.ctx, loopId);
  }

  getReviewComments(loopId: string): Array<{
    id: string;
    loopId: string;
    reviewCycle: number;
    commentText: string;
    createdAt: string;
    status: "pending" | "addressed";
    addressedAt?: string;
  }> {
    return getReviewCommentsImpl(this.ctx, loopId);
  }

  async saveLastUsedModel(model: {
    providerID: string;
    modelID: string;
    variant?: string;
  }): Promise<void> {
    return saveLastUsedModelImpl(this.ctx, model);
  }

  isRunning(loopId: string): boolean {
    return isRunningImpl(this.ctx, loopId);
  }

  getRunningLoopState(loopId: string): LoopState | null {
    return getRunningLoopStateImpl(this.ctx, loopId);
  }

  async shutdown(): Promise<void> {
    return shutdownImpl(this.ctx);
  }

  async forceResetAll(): Promise<{ enginesCleared: number; loopsReset: number }> {
    return forceResetAllImpl(this.ctx);
  }

  resetForTesting(): void {
    return resetForTestingImpl(this.ctx);
  }

  private async recoverPlanningEngine(loopId: string): Promise<LoopEngine> {
    return recoverPlanningEngineImpl(this.ctx, loopId);
  }
}

/**
 * Singleton instance of LoopManager.
 */
export const loopManager = new LoopManager();
