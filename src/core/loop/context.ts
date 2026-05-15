/**
 * Shared context passed to all LoopManager sub-module functions.
 */
import type { LoopEngine } from "../loop-engine";
import type { SimpleEventEmitter } from "../event-emitter";
import type { LoopEvent } from "../../types/events";
import type { Loop, ModelConfig } from "../../types/loop";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { GitService } from "../git-service";
import type { CommandExecutor } from "../command-executor";
import type { SendFollowUpResult } from "./loop-types";
import type { AcceptPlanResult, AcceptPlanOptions } from "./loop-types";
import type { AutomaticPrFlowState } from "../../types/loop";
import type { PushLoopResult } from "./loop-types";

export interface LoopCtx {
  engines: Map<string, LoopEngine>;
  emitter: SimpleEventEmitter<LoopEvent>;
  loopsBeingAccepted: Set<string>;
  // Cross-module callbacks (bound in LoopManager constructor)
  stopLoop(loopId: string, reason?: string): Promise<void>;
  deleteLoop(loopId: string): Promise<boolean>;
  discardLoop(loopId: string): Promise<{ success: boolean; error?: string }>;
  getLoop(loopId: string): Promise<Loop | null>;
  startLoop(loopId: string, options?: { attachments?: MessageImageAttachment[] }): Promise<void>;
  startPlanMode(loopId: string, options?: { attachments?: MessageImageAttachment[] }): Promise<void>;
  acceptPlan(loopId: string, options?: AcceptPlanOptions): Promise<AcceptPlanResult>;
  pushLoop(loopId: string): Promise<PushLoopResult>;
  startAutomaticPrFlow(
    loopId: string,
  ): Promise<{ success: boolean; error?: string; automaticPrFlow?: AutomaticPrFlowState }>;
  startStatePersistence(loopId: string): void;
  ensureLoopBranchCheckedOut(loop: Loop, git: GitService, workingDirectory: string): Promise<void>;
  validateMainCheckoutStart(loop: Loop, git: GitService): Promise<void>;
  clearPlanningFiles(loopId: string, loop: Loop, executor: CommandExecutor, worktreePath: string): Promise<void>;
  recoverPlanningEngine(loopId: string): Promise<LoopEngine>;
  startFeedbackCycle(
    loopId: string,
    options: { prompt: string; model?: ModelConfig; reviewCommentText?: string; attachments?: MessageImageAttachment[] },
  ): Promise<SendFollowUpResult>;
  jumpstartLoop(loopId: string, options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }): Promise<{ success: boolean; error?: string }>;
}
