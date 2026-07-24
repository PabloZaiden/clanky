/**
 * Task engine for Clanky Tasks Management System.
 * Handles the execution of Clanky Task iterations.
 * Each iteration sends a prompt to the AI agent and checks for completion.
 *
 * Types and helpers are organized into:
 * - engine-types.ts: Interfaces and constants
 * - engine-helpers.ts: StopPatternDetector
 * - engine-events.ts: Log and persistence helpers
 * - engine-prompt.ts: Prompt building and outcome evaluation
 * - engine-git.ts: Git branch setup, worktree, and commit operations
 * - engine-session.ts: Session setup, reconnection, and model changes
 * - engine-tools.ts: Agent event processing
 */

import type { FollowUpPromptMode, TaskConfig, TaskState, Task, IterationSummary, TaskLogEntry, ModelConfig } from "@/shared/task";
import { DEFAULT_TASK_CONFIG } from "@/shared/task";
import type { TaskEvent, MessageData, ToolCallData, LogLevel } from "@/shared/events";
import { createTimestamp } from "@/shared/events";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type {
  PromptInput,
  AgentEvent,
} from "../../backends/types";
import { backendManager } from "../backend-manager";
import type { GitService } from "../git";
import { SimpleEventEmitter, taskEventEmitter } from "../event-emitter";
import { log } from "@pablozaiden/webapp/server";
import { markCommentsAsAddressed } from "../../persistence/review-comments";
import { assertValidTransition } from "../task-state-machine";
import { ensurePlanningDirectory } from "../planning-directory";
import { getPlanFilePath } from "../../lib/planning-files";

import {
  type TaskBackend,
  type TaskEngineOptions,
  type IterationResult,
  type IterationContext,
} from "./engine-types";
import { AgentStreamController, type AgentStreamHandle } from "../agent-stream-controller";
import { resolveToolCallImagePreview, getImageViewToolPath } from "../tool-call-image-preview";
import { upsertToolCallExtra } from "@/shared/tool-call";
import { StopPatternDetector } from "./engine-helpers";
import { logToConsole, persistTaskLog, persistTaskMessage, persistTaskToolCall } from "./engine-events";
import { buildTaskPrompt, evaluateTaskOutcome, type PromptBuildContext } from "./engine-prompt";
import {
  clearTaskPlanningFolder,
  setupTaskGitBranch,
  commitTaskIteration,
  type GitOperationContext,
  type GitCommitContext,
} from "./engine-git";
import {
  setupTaskSession,
  reconnectTaskSession,
  recreateSessionAfterLoss,
  handleModelChange,
  resetIterationContextForRetry,
  type SessionOperationContext,
} from "./engine-session";
import { processTaskAgentEvent, handleQuestionAsked as handleTaskQuestionAsked, type ToolProcessingContext } from "./engine-tools";
import {
  AcpError,
  createAcpSessionNotFoundError,
  getAcpErrorMessage,
  isAcpErrorCode,
} from "../../backends/acp";

export class TaskEngine {
  private task: Task;
  private backend: TaskBackend;
  private git: GitService;
  private emitter: SimpleEventEmitter<TaskEvent>;
  private stopDetector: StopPatternDetector;
  private aborted = false;
  private sessionId: string | null = null;
  private onPersistState?: (state: TaskState) => Promise<void>;
  private onPlanReady?: () => Promise<void>;
  private onCompleted?: () => Promise<void>;
  /** Guard to prevent concurrent runTask() executions */
  private isTaskRunning = false;
  /** Skip git branch setup (for review cycles) */
  private skipGitSetup: boolean;
  /**
   * Flag to indicate that a pending prompt/model was injected and the current
   * iteration should be aborted to immediately start a new one with the injected values.
   * This is different from `aborted` which stops the task entirely.
   */
  private injectionPending = false;
  private initialPromptAttachments: MessageImageAttachment[];
  private pendingPromptAttachments: MessageImageAttachment[] = [];
  private currentStreamHandle: AgentStreamHandle | null = null;
  private activeSessionInterrupt: Promise<void> | null = null;

  constructor(options: TaskEngineOptions) {
    this.task = options.task;
    this.backend = options.backend;
    this.git = options.gitService;
    this.emitter = options.eventEmitter ?? taskEventEmitter;
    this.stopDetector = new StopPatternDetector(options.task.config.stopPattern);
    this.onPersistState = options.onPersistState;
    this.onPlanReady = options.onPlanReady;
    this.onCompleted = options.onCompleted;
    this.skipGitSetup = options.skipGitSetup ?? false;
    this.initialPromptAttachments = [...(options.initialPromptAttachments ?? [])];
  }

  /**
   * Get the current task state.
   */
  get state(): TaskState {
    return this.task.state;
  }

  /**
   * Get the task configuration.
   */
  get config(): TaskConfig {
    return this.task.config;
  }

  /**
   * Get the effective working directory for this task.
   * Returns the worktree path when worktrees are enabled, otherwise the
   * repository directory itself.
   */
  get workingDirectory(): string {
    if (!this.config.useWorktree) {
      return this.config.directory;
    }
    const worktreePath = this.task.state.git?.worktreePath;
    if (!worktreePath) {
      throw new Error(
        `Task ${this.config.id} has no worktree path. ` +
        `This task is configured to use a dedicated worktree. ` +
        `This is a bug -- workingDirectory was accessed before setupGitBranch() set the worktree path.`
      );
    }
    return worktreePath;
  }

  /**
   * Set a pending prompt that will be used for the next iteration.
   * This overrides the config.prompt for one iteration only.
   */
  setPendingPrompt(
    prompt: string,
    attachments: MessageImageAttachment[] = [],
    promptMode: FollowUpPromptMode = "task_context",
  ): void {
    this.updateState({ pendingPrompt: prompt, pendingPromptMode: promptMode });
    this.pendingPromptAttachments = [...attachments];
  }

  /**
   * Clear any pending prompt, reverting to the config.prompt.
   */
  clearPendingPrompt(): void {
    this.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined });
    this.pendingPromptAttachments = [];
  }

  /**
   * Set a pending model to use for the next iteration.
   * This overrides the config.model and becomes the new default after use.
   */
  setPendingModel(model: ModelConfig): void {
    this.updateState({ pendingModel: model });
    // Emit event for UI update
    this.emitter.emit({
      type: "task.pending.updated",
      taskId: this.task.config.id,
      pendingModel: model,
      timestamp: createTimestamp(),
    });
  }

  /**
   * Clear any pending model.
   */
  clearPendingModel(): void {
    this.updateState({ pendingModel: undefined });
    // Emit event for UI update
    this.emitter.emit({
      type: "task.pending.updated",
      taskId: this.task.config.id,
      pendingModel: undefined,
      timestamp: createTimestamp(),
    });
  }

  /**
   * Clear all pending values (prompt and model).
   */
  clearPending(): void {
    this.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined, pendingModel: undefined });
    this.pendingPromptAttachments = [];
    // Emit event for UI update
    this.emitter.emit({
      type: "task.pending.updated",
      taskId: this.task.config.id,
      pendingPrompt: undefined,
      pendingModel: undefined,
      timestamp: createTimestamp(),
    });
  }

  /**
   * Inject pending prompt and/or model immediately.
   * Running tasks abort the current iteration so the replacement values are
   * applied on the next iteration without resetting the conversation history.
   *
   * The session is preserved (conversation history maintained), only the current
   * AI processing is interrupted.
   *
   * @param options - The pending prompt and/or model to inject
   */
  async injectPendingNow(options: {
    message?: string;
    model?: ModelConfig;
    attachments?: MessageImageAttachment[];
  }): Promise<void> {
    // Set the pending values first
    if (options.message !== undefined) {
      this.updateState({ pendingPrompt: options.message, pendingPromptMode: "task_context" });
      this.pendingPromptAttachments = [...(options.attachments ?? [])];
    } else if (options.attachments) {
      this.pendingPromptAttachments = [...options.attachments];
    }
    if (options.model !== undefined) {
      this.updateState({ pendingModel: options.model });
    }

    // Emit event for UI update
    this.emitter.emit({
      type: "task.pending.updated",
      taskId: this.task.config.id,
      pendingPrompt: options.message,
      pendingModel: options.model,
      timestamp: createTimestamp(),
    });

    // If the task is not actively running an iteration, no need to abort
    if (!this.isTaskRunning) {
      this.emitLog("debug", "Pending values set, task not actively running - will apply on next iteration");
      return;
    }

    // Mark that we're doing an injection abort (not a user stop)
    this.injectionPending = true;

    // Abort the current session to interrupt AI processing
    if (this.sessionId) {
      try {
        this.emitLog("info", "Injecting pending message - aborting current AI processing");
        await this.backend.abortSession(this.sessionId);
      } catch {
        // Ignore abort errors - the session may already be complete
      }
    }
  }

  private continueWithAbortFallbackInjection(errorMessage?: string): boolean {
    this.emitLog("info", "Abort-based injection interrupted the current iteration - continuing with pending input", {
      errorMessage,
    });
    this.aborted = false;
    this.injectionPending = false;
    this.updateState({ consecutiveErrors: undefined });
    return false;
  }

  private resetRestartFlags(): void {
    this.aborted = false;
    this.injectionPending = false;
  }

  private async interruptActiveSession(options: {
    abortMessage: string;
    abortWarnMessage: string;
    forceDisconnect: boolean;
    markAborted?: boolean;
    disconnectMessage?: string;
    disconnectWarnMessage?: string;
  }): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    const activeSessionId = this.sessionId;
    const interruptPromise = (async () => {
      if (options.markAborted) {
        this.aborted = true;
      }

      this.currentStreamHandle?.close();

      try {
        this.emitLog("info", options.abortMessage);
        await this.backend.abortSession(activeSessionId);
      } catch (error) {
        this.emitLog("warn", options.abortWarnMessage, {
          error: String(error),
        });
      }

      if (!options.forceDisconnect) {
        return;
      }

      if (!this.backend.isConnected()) {
        this.sessionId = null;
        return;
      }

      try {
        this.emitLog("info", options.disconnectMessage ?? "Disconnecting the backend to finish interrupting the active session");
        await this.backend.disconnect();
      } catch (error) {
        this.emitLog("warn", options.disconnectWarnMessage ?? "Failed to disconnect the backend after interrupting the active session", {
          error: String(error),
        });
      } finally {
        this.sessionId = null;
      }
    })();

    this.activeSessionInterrupt = interruptPromise.finally(() => {
      if (this.activeSessionInterrupt === interruptPromise) {
        this.activeSessionInterrupt = null;
      }
    });

    await this.activeSessionInterrupt;
  }

  /**
   * Wait for any ongoing task iteration to complete.
   * Used to ensure state modifications happen between iterations.
   */
  async waitForTaskIdle(timeoutMs = 30000): Promise<void> {
    const startTime = Date.now();
    while (this.isTaskRunning) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timed out waiting for task to become idle after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Start the task execution.
   * This sets up the git branch and backend session.
   */
  async start(): Promise<void> {
    // Allow starting from idle, stopped, planning (for plan mode), or resolving_conflicts (for conflict resolution)
    if (this.task.state.status !== "idle" && this.task.state.status !== "stopped" && this.task.state.status !== "planning" && this.task.state.status !== "resolving_conflicts") {
      throw new Error(`Cannot start task in status: ${this.task.state.status}`);
    }

    this.emitLog("info", "Starting task execution", { taskName: this.config.name });

    this.resetRestartFlags();

    // Only update status if not in plan mode (preserve "planning" status)
    const isInPlanMode = this.task.state.status === "planning";
    this.updateState({
      status: isInPlanMode ? "planning" : "starting",
      // Preserve existing startedAt (e.g., set by startPlanMode, or from a previous run
      // during jumpstart/review). Only set if not already present, so the timestamp
      // used for branch naming stays consistent with the persisted startedAt.
      startedAt: this.task.state.startedAt ?? createTimestamp(),
      currentIteration: 0,
      recentIterations: [],
      error: undefined,
    });

    try {
      // Set up git branch first (before any file modifications)
      // Skip git setup in plan mode - already set up in startPlanMode()
      // Skip git setup for review cycles - branch is already set up
      if (!isInPlanMode && !this.skipGitSetup) {
        this.emitLog("info", "Setting up git branch...");
        log.debug("[TaskEngine] Starting setupGitBranch...");
        await this.setupGitBranch();
        log.debug("[TaskEngine] setupGitBranch completed successfully");
      } else if (this.skipGitSetup) {
        this.emitLog("info", "Skipping git branch setup (review cycle)");
      }

      const planningExecutor = await backendManager.getCommandExecutorAsync(this.config.workspaceId, this.workingDirectory);
      await ensurePlanningDirectory(planningExecutor, this.workingDirectory);

      // Clear .clanky-planning folder if requested (after branch setup, so deletions are on the new branch)
      // NEVER clear if plan mode already cleared it
      if (this.task.state.planMode?.planningFolderCleared) {
        this.emitLog("info", "Skipping .clanky-planning folder clear - already cleared during plan mode");
      } else if (this.config.clearPlanningFolder) {
        this.emitLog("info", "Clearing .clanky-planning folder...");
        await this.clearPlanningFolder();
      }

      // Create backend session
      this.emitLog("info", "Connecting to AI backend...");
      log.debug("[TaskEngine] Starting setupSession...");
      await this.setupSession();
      log.debug("[TaskEngine] setupSession completed successfully");

      // Emit started event (skip in plan mode - will emit when plan is accepted)
      if (!isInPlanMode) {
        log.debug("[TaskEngine] About to emit task.started event");
        this.emit({
          type: "task.started",
          taskId: this.config.id,
          iteration: 0,
          timestamp: createTimestamp(),
        });
        log.debug("[TaskEngine] task.started event emitted");
      }

      log.debug("[TaskEngine] About to emit 'Task started successfully' log");
      this.emitLog("info", "Task started successfully, beginning iterations");
      log.debug("[TaskEngine] 'Task started successfully' log emitted");

      // Start the iteration task
      log.debug("[TaskEngine] About to call runTask");
      await this.runTask();
      log.debug("[TaskEngine] runTask completed");
    } catch (error) {
      this.emitLog("error", `Failed to start task: ${String(error)}`);
      this.handleError(error);
    }
  }

  /**
   * Stop the task execution.
   */
  async stop(reason = "User requested stop"): Promise<void> {
    this.emitLog("info", `Stopping task: ${reason}`);
    this.aborted = true;

    // Clear the persistence callback to prevent stale async operations
    // from overwriting state after the task is stopped/deleted
    this.onPersistState = undefined;

    await this.interruptActiveSession({
      abortMessage: "Aborting backend session...",
      abortWarnMessage: "Failed to abort the backend session during stop",
      forceDisconnect: true,
      markAborted: true,
      disconnectMessage: "Disconnecting the backend so the active turn stops immediately",
      disconnectWarnMessage: "Failed to disconnect the backend while stopping the task",
    });

    this.updateState({
      status: "stopped",
      completedAt: createTimestamp(),
    });

    this.emit({
      type: "task.stopped",
      taskId: this.config.id,
      reason,
      timestamp: createTimestamp(),
    });

    this.emitLog("info", "Task stopped");
  }

  /**
   * Abort the backend session without changing task status.
   * Used during force reset to preserve planning tasks while cleaning up resources.
   * The engine will be cleared from memory, but the task status remains unchanged.
   */
  async abortSessionOnly(reason = "Connection reset requested"): Promise<void> {
    this.emitLog("info", `Aborting session only (preserving status): ${reason}`);
    this.aborted = true;

    // Clear the persistence callback to prevent stale async operations
    this.onPersistState = undefined;

    if (this.sessionId) {
      try {
        this.emitLog("info", "Aborting backend session...");
        await this.backend.abortSession(this.sessionId);
      } catch {
        // Ignore abort errors
      }
    }

    this.emit({
      type: "task.session_aborted",
      taskId: this.config.id,
      reason,
      timestamp: createTimestamp(),
    });

    this.emitLog("info", "Session aborted (status preserved)");
  }

  /**
   * Set up git branch and optional worktree for the task (public method for plan mode).
   * Called from startPlanMode() before the AI session starts.
   */
  async setupGitBranchForPlanAcceptance(): Promise<void> {
    await this.setupGitBranch(true);
  }

  /**
   * Run a single plan mode iteration.
   * Used to process feedback or continue plan refinement.
   * The engine must already be in planning status.
   */
  async runPlanIteration(): Promise<void> {
    if (this.task.state.status !== "planning") {
      throw new Error(`Cannot run plan iteration in status: ${this.task.state.status}`);
    }

    this.resetRestartFlags();

    // Run the task (will run one iteration and return on plan_ready or error)
    await this.runTask();
  }

  /**
   * Inject plan feedback immediately.
   *
   * If the task is actively running an iteration, the current turn is interrupted
   * so the feedback is applied on the next iteration. If the task is idle
   * (e.g., plan was already ready), starts a new plan iteration as a
   * fire-and-forget operation.
   *
   * The caller (TaskManager.sendPlanFeedback) is responsible for:
   * - Incrementing feedbackRounds and resetting isPlanReady before calling this
   * - Persisting state changes
   * - Emitting the task.plan.feedback event
   *
   * @param feedback - The user's feedback message
   */
  async injectPlanFeedback(feedback: string, attachments: MessageImageAttachment[] = []): Promise<void> {
    // Set the feedback as a pending prompt
    this.updateState({ pendingPrompt: feedback });
    this.pendingPromptAttachments = [...attachments];

    // Emit event for UI update
    this.emitter.emit({
      type: "task.pending.updated",
      taskId: this.task.config.id,
      pendingPrompt: feedback,
      timestamp: createTimestamp(),
    });

    if (this.isTaskRunning) {
      // Task is actively running an iteration — inject by aborting current processing.
      // The runTask() while-task detects injectionPending after abort, resets the
      // flags, and continues to the next iteration which picks up pendingPrompt.
      this.injectionPending = true;

      if (this.sessionId) {
        try {
          this.emitLog("info", "Injecting plan feedback - aborting current AI processing");
          await this.backend.abortSession(this.sessionId);
        } catch {
          // Ignore abort errors - the session may already be complete
        }
      }
    } else {
      // Task is idle (plan was ready, or between iterations) — start a new plan iteration.
      // Fire-and-forget: the plan iteration runs asynchronously and will emit events/update state.
      // This matches the pattern used by engine.start() and continueExecution() fire-and-forget calls.
      this.emitLog("info", "Injecting plan feedback - starting new plan iteration");
      this.runPlanIteration().catch((error) => {
        this.emitLog("error", `Plan feedback iteration failed: ${String(error)}`);
      });
    }
  }

  /**
   * Continue task execution after plan acceptance.
   * Used to start the execution phase after a plan has been accepted.
   * The engine must be in running status with a pending prompt set.
   */
  async continueExecution(): Promise<void> {
    if (this.task.state.status !== "running") {
      throw new Error(`Cannot continue execution in status: ${this.task.state.status}`);
    }

    // Check if already running (guard against duplicate calls)
    if (this.isTaskRunning) {
      log.warn("[TaskEngine] continueExecution: Task is already running, ignoring duplicate call");
      this.emitLog("warn", "Execution already in progress, ignoring duplicate continueExecution call");
      return;
    }

    log.debug("[TaskEngine] continueExecution: Starting execution task");
    this.emitLog("info", "Starting execution after plan acceptance");

    this.resetRestartFlags();

    // Run the task
    await this.runTask();
  }

  /**
   * Run exactly one plain chat turn without applying normal task completion-marker semantics.
   */
  async runSingleTurn(): Promise<void> {
    if (this.task.state.status !== "running") {
      throw new Error(`Cannot run a single turn in status: ${this.task.state.status}`);
    }

    if (this.isTaskRunning) {
      log.warn("[TaskEngine] runSingleTurn: Task is already running, ignoring duplicate call");
      this.emitLog("warn", "Execution already in progress, ignoring duplicate single-turn call");
      return;
    }

    this.resetRestartFlags();
    this.isTaskRunning = true;

    try {
      this.emitLog("info", "Starting single-turn plain chat execution");
      const result = await this.runIteration();

      const currentStatus = this.task.state.status as TaskState["status"];
      if (this.aborted || currentStatus === "stopped") {
        await this.triggerPersistence();
        return;
      }

      if (result.outcome === "error") {
        const message = result.error ?? "Unknown error";
        this.emitLog("error", `Single-turn execution failed: ${message}`);
        this.updateState({
          status: "failed",
          completedAt: createTimestamp(),
          error: {
            message,
            iteration: this.task.state.currentIteration,
            timestamp: createTimestamp(),
          },
        });
        this.emit({
          type: "task.error",
          taskId: this.config.id,
          error: message,
          iteration: this.task.state.currentIteration,
          timestamp: createTimestamp(),
        });
        await this.triggerPersistence();
        return;
      }

      this.emitLog("info", "Single-turn plain chat execution finished; waiting for manual user action");
      this.updateState({
        status: "stopped",
        completedAt: createTimestamp(),
        consecutiveErrors: undefined,
      });
      this.emit({
        type: "task.stopped",
        taskId: this.config.id,
        reason: "Plain chat turn finished",
        timestamp: createTimestamp(),
      });
      await this.triggerPersistence();
    } finally {
      this.isTaskRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Thin delegators for extracted private methods
  // ---------------------------------------------------------------------------

  /**
   * Clear the .clanky-planning folder contents (except .gitkeep).
   * If any tracked files were deleted, commits the changes.
   */
  private async clearPlanningFolder(): Promise<void> {
    await clearTaskPlanningFolder(this.makeGitContext());
  }

  /**
   * Set up git branch for the task using either a dedicated worktree or the main checkout.
   */
  private async setupGitBranch(_allowPlanningFolderChanges = false): Promise<void> {
    await setupTaskGitBranch(this.makeGitContext(), _allowPlanningFolderChanges);
  }

  /**
   * Set up the backend session.
   * Uses workspace-specific server settings.
   */
  private async setupSession(): Promise<void> {
    await setupTaskSession(this.makeSessionContext());
  }

  /**
   * Reconnect to an existing session for plan mode feedback.
   * This is called when the engine is recreated after a server restart
   * while a task is still in planning mode.
   */
  async reconnectSession(): Promise<void> {
    await reconnectTaskSession(this.makeSessionContext());
  }

  /**
   * Recreate the current ACP session after remote session loss.
   */
  private async recreateSessionAfterSessionLoss(reason: string): Promise<void> {
    await recreateSessionAfterLoss(this.makeSessionContext(), reason);
  }

  /**
   * Handle pending model changes via ACP session config options.
   * Uses session/set_config_option to change the model without process restart.
   * Works for all ACP agents (copilot, opencode, and future ones).
   */
  private async handlePendingModelChange(): Promise<void> {
    await handleModelChange(this.makeSessionContext());
  }

  /**
   * Reset transient per-iteration state before retrying a prompt with a new session.
   */
  private resetIterationContextForRetry(ctx: IterationContext): void {
    resetIterationContextForRetry(ctx);
  }

  /**
   * Process a single agent event during an iteration.
   * Handles all event types: message streaming, tool calls, errors,
   * permissions, questions, TODOs, and session status updates.
   */
  private async processAgentEvent(event: AgentEvent, ctx: IterationContext): Promise<void> {
    // Route question events through this.handleQuestionAsked for testability
    if (event.type === "question.asked") {
      await this.handleQuestionAsked(event);
      return;
    }
    await processTaskAgentEvent(event, ctx, this.makeToolContext());
  }

  /**
   * Auto-respond to a question from the AI with a default answer.
   * Exposed as a private method for testability.
   */
  private async handleQuestionAsked(event: AgentEvent & { type: "question.asked" }): Promise<void> {
    await handleTaskQuestionAsked(event, this.makeToolContext());
  }

  /**
   * Build the prompt for an iteration.
   */
  private buildPrompt(_iteration: number): PromptInput {
    return buildTaskPrompt(this.makePromptContext(), _iteration);
  }

  /**
   * Evaluate the iteration outcome by checking stop patterns.
   */
  private evaluateOutcome(ctx: IterationContext): void {
    evaluateTaskOutcome(ctx, this.makePromptContext());
  }

  /**
   * Commit changes after an iteration.
   */
  private async commitIteration(iteration: number, responseContent: string): Promise<void> {
    await commitTaskIteration(this.makeGitCommitContext(), iteration, responseContent);
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers (delegate to engine-events helpers + updateState)
  // ---------------------------------------------------------------------------

  /**
   * Persist a log entry in the task state.
   * If isUpdate is true, update an existing entry; otherwise append.
   * Evicts oldest entries when buffer exceeds MAX_PERSISTED_LOGS.
   */
  private persistLog(entry: TaskLogEntry, isUpdate: boolean): void {
    const logs = this.task.state.logs ?? [];
    this.updateState({ logs: persistTaskLog(logs, entry, isUpdate) });
  }

  /**
   * Persist a message in the task state for page refresh recovery.
   * Evicts oldest entries when buffer exceeds MAX_PERSISTED_MESSAGES.
   */
  private persistMessage(message: MessageData): void {
    const messages = this.task.state.messages ?? [];
    this.updateState({ messages: persistTaskMessage(messages, message) });
  }

  /**
   * Persist a tool call in the task state for page refresh recovery.
   * Updates existing tool call if it exists (by ID), otherwise adds new.
   * Evicts oldest entries when buffer exceeds MAX_PERSISTED_TOOL_CALLS.
   */
  private persistToolCall(toolCall: ToolCallData): void {
    const toolCalls = this.task.state.toolCalls ?? [];
    this.updateState({ toolCalls: persistTaskToolCall(toolCalls, toolCall) });
  }

  /**
   * Emit an application log event.
   * Used to communicate internal task engine operations to the UI.
   * Also persists the log in the task state for page refresh recovery.
   * @param level - The log level for the event (used for SSE events and persistence)
   * @param message - The log message
   * @param details - Optional additional details
   * @param id - Optional ID for updating existing log entries
   * @param consoleLevel - Optional override for the server console log level.
   *                       When provided, this level is used for console output instead of deriving from `level`.
   *                       Useful for reducing console verbosity while keeping frontend events unchanged.
   * @returns The ID of the log entry (for updates)
   */
  private emitLog(
    level: LogLevel,
    message: string,
    details?: Record<string, unknown>,
    id?: string,
    consoleLevel?: "trace" | "debug" | "info" | "warn" | "error"
  ): string {
    const logId = id ?? `log-${this.config.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = createTimestamp();

    const taskPrefix = `[Task:${this.config.name}]`;
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";

    logToConsole(level, taskPrefix, message, detailsStr, consoleLevel);

    // Persist log in task state (for page refresh recovery)
    const logEntry: TaskLogEntry = {
      id: logId,
      level,
      message,
      details,
      timestamp,
    };
    this.persistLog(logEntry, id !== undefined);

    // Emit log event for real-time updates
    this.emit({
      type: "task.log",
      taskId: this.config.id,
      id: logId,
      level,
      message,
      details,
      timestamp,
    });
    return logId;
  }

  private emitLogDelta(
    level: LogLevel,
    message: string,
    delta: string,
    fullContent: string,
    logKind: "response" | "reasoning",
    id: string,
  ): void {
    const timestamp = createTimestamp();
    const logs = this.task.state.logs ?? [];
    const existing = logs.find((logEntry) => logEntry.id === id);
    const logTimestamp = existing?.timestamp ?? timestamp;
    const entry: TaskLogEntry = {
      id,
      level,
      message,
      details: {
        logKind,
        responseContent: fullContent,
      },
      timestamp: logTimestamp,
    };
    this.persistLog(entry, true);
    this.emit({
      type: "task.log.delta",
      taskId: this.config.id,
      id,
      level,
      message,
      logKind,
      delta,
      baseLength: Math.max(0, fullContent.length - delta.length),
      contentLength: fullContent.length,
      logTimestamp,
      timestamp,
    });
  }

  // ---------------------------------------------------------------------------
  // Context factory methods
  // ---------------------------------------------------------------------------

  private makeGitContext(): GitOperationContext {
    // Use a safe fallback for workingDirectory during git branch setup
    // (before the worktree path is established in state)
    const workingDirectory =
      !this.config.useWorktree
        ? this.config.directory
        : (this.task.state.git?.worktreePath ?? this.config.directory);
    return {
      git: this.git,
      config: this.task.config,
      state: this.task.state,
      workingDirectory,
      emitLog: this.emitLog.bind(this),
      updateState: this.updateState.bind(this),
      emit: this.emit.bind(this),
    };
  }

  private makeGitCommitContext(): GitCommitContext {
    return {
      ...this.makeGitContext(),
      // Override workingDirectory with the actual working directory for commits
      workingDirectory: this.workingDirectory,
      backend: this.backend,
      sessionId: this.sessionId,
    };
  }

  private makeSessionContext(): SessionOperationContext {
    // Use a safe fallback for workingDirectory (same logic as makeGitContext)
    const workingDirectory =
      !this.config.useWorktree
        ? this.config.directory
        : (this.task.state.git?.worktreePath ?? this.config.directory);
    return {
      backend: this.backend,
      config: this.task.config,
      state: this.task.state,
      workingDirectory,
      emitLog: this.emitLog.bind(this),
      updateState: this.updateState.bind(this),
      getSessionId: () => this.sessionId,
      setSessionId: (id: string | null) => { this.sessionId = id; },
    };
  }

  private makePromptContext(): PromptBuildContext {
    return {
      config: this.task.config,
      state: this.task.state,
      workingDirectory: this.workingDirectory,
      stopDetector: this.stopDetector,
      emitUserMessage: this.emitUserMessage.bind(this),
      emitLog: this.emitLog.bind(this),
      updateState: this.updateState.bind(this),
      consumeInitialPromptAttachments: this.consumeInitialPromptAttachments.bind(this),
      consumePendingPromptAttachments: this.consumePendingPromptAttachments.bind(this),
    };
  }

  private makeToolContext(): ToolProcessingContext {
    return {
      taskId: this.config.id,
      config: this.task.config,
      state: this.task.state,
      backend: this.backend,
      sessionId: this.sessionId,
      emitLog: this.emitLog.bind(this),
      emitLogDelta: this.emitLogDelta.bind(this),
      emit: this.emit.bind(this),
      updateState: this.updateState.bind(this),
      persistMessage: this.persistMessage.bind(this),
      persistToolCall: this.persistToolCall.bind(this),
      triggerPersistence: this.triggerPersistence.bind(this),
      scheduleToolImagePreview: this.scheduleToolImagePreview.bind(this),
    };
  }

  private scheduleToolImagePreview(toolCall: ToolCallData, iteration: number): void {
    const path = getImageViewToolPath(toolCall.name, toolCall.input);
    if (!path) {
      return;
    }

    // Resolve previews in the background so the main tool flow stays responsive.
    void (async () => {
      try {
        const extra = await resolveToolCallImagePreview({
          workspaceId: this.config.workspaceId,
          directory: this.workingDirectory,
          path,
          toolCallId: toolCall.id,
        });
        if (!extra) {
          return;
        }

        const currentTool = this.task.state.toolCalls.find((entry) => entry.id === toolCall.id);
        if (!currentTool) {
          return;
        }

        this.persistToolCall({
          ...currentTool,
          extras: upsertToolCallExtra(currentTool.extras, extra),
        });
        this.emit({
          type: "task.tool_call.extra",
          taskId: this.config.id,
          iteration,
          toolId: toolCall.id,
          extra,
          timestamp: createTimestamp(),
        });
        await this.triggerPersistence();
      } catch (error) {
        this.emitLog("debug", "Skipping tool image preview generation", {
          toolId: toolCall.id,
          error: String(error),
        });
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Core task methods (unchanged from original)
  // ---------------------------------------------------------------------------

  /**
   * Run the main iteration task.
   * Now continues on errors unless max consecutive identical errors is reached.
   * Protected by isTaskRunning guard to prevent concurrent executions.
   */
  private async runTask(): Promise<void> {
    log.debug("[TaskEngine] runTask: Entry point");

    // Guard against concurrent runTask() calls
    if (this.isTaskRunning) {
      log.warn("[TaskEngine] runTask: Already running, skipping duplicate call");
      this.emitLog("warn", "Task execution already in progress, ignoring duplicate call");
      return;
    }

    this.isTaskRunning = true;
    log.debug("[TaskEngine] runTask: Set isTaskRunning = true");

    try {
      this.emitLog("debug", "Entering runTask", {
        aborted: this.aborted,
        status: this.task.state.status,
        shouldContinue: this.shouldContinue(),
      });
      log.debug("[TaskEngine] runTask: Emitted debug log, checking while condition", {
        aborted: this.aborted,
        shouldContinue: this.shouldContinue(),
      });

      while (!this.aborted && this.shouldContinue()) {
        log.debug("[TaskEngine] runTask: Entered while task, about to call runIteration");
        this.emitLog("debug", "Task iteration check passed", {
          aborted: this.aborted,
          status: this.task.state.status,
        });

        const iterationResult = await this.runIteration();
        log.debug("[TaskEngine] runTask: runIteration completed", { outcome: iterationResult.outcome });

        // Delegate outcome handling — returns true if the task should exit
        const shouldExit = await this.handleIterationOutcome(iterationResult);
        if (shouldExit) {
          // Check if an injection arrived during outcome handling (e.g., plan feedback
          // arrived between evaluateOutcome and handlePlanReadyOutcome, while
          // isTaskRunning was still true). If so, clear the flags and continue
          // the while task to process the injected prompt instead of exiting.
          if (this.injectionPending && this.shouldContinue()) {
            this.emitLog("debug", "Injection pending during outcome handling - continuing task to process injected prompt");
            this.aborted = false;
            this.injectionPending = false;
            continue;
          }
          return;
        }

        // Check max iterations
        if (await this.hasReachedMaxIterations()) {
          return;
        }

        // Check if aborted during iteration
        if (this.aborted) {
          // Check if this was an injection abort (not a user stop)
          if (this.injectionPending) {
            this.emitLog("debug", "Injection abort detected, restarting iteration with pending values");
            // Reset both flags to allow the task to continue
            this.aborted = false;
            this.injectionPending = false;
            // Continue the while task - next iteration will use pending values
            continue;
          }
          this.emitLog("debug", "Aborted during iteration, exiting runTask");
          return; // Stop method already updated status
        }
      }

      this.emitLog("debug", "Exiting runTask - task condition not met", {
        aborted: this.aborted,
        status: this.task.state.status,
        shouldContinue: this.shouldContinue(),
      });
    } finally {
      this.isTaskRunning = false;
      log.debug("[TaskEngine] runTask: Set isTaskRunning = false");
    }
  }

  /**
   * Handle the outcome of a single iteration.
   * Returns true if the task should exit, false to continue iterating.
   */
  private async handleIterationOutcome(result: IterationResult): Promise<boolean> {
    if (result.outcome === "blocked") {
      return this.handleBlockedOutcome();
    }

    if (result.outcome === "complete") {
      return this.handleCompletedOutcome();
    }

    if (result.outcome === "plan_ready") {
      return this.handlePlanReadyOutcome(result);
    }

    if (result.outcome === "error") {
      return this.handleErrorOutcome(result);
    }

    // Successful iteration (outcome === "continue") - clear error tracker
    this.updateState({ consecutiveErrors: undefined });
    return false;
  }

  /**
   * Handle a BLOCKED iteration outcome.
   * Reuses the stopped task state so the user can resolve the blocker and
   * resume the task with a follow-up, without enabling completion actions.
   */
  private async handleBlockedOutcome(): Promise<boolean> {
    this.emitLog("warn", "Agent reported BLOCKED - task stopped without completion", {
      totalIterations: this.task.state.currentIteration,
    });
    this.updateState({
      status: "stopped",
      completedAt: createTimestamp(),
      consecutiveErrors: undefined,
    });

    this.emit({
      type: "task.stopped",
      taskId: this.config.id,
      reason: "Agent reported a blocker",
      timestamp: createTimestamp(),
    });

    await this.triggerPersistence();
    return true;
  }

  /**
   * Handle a "complete" iteration outcome.
   * Updates state, marks review comments as addressed, emits completion event.
   * Always returns true (task should exit).
   */
  private async handleCompletedOutcome(): Promise<boolean> {
    this.emitLog("info", "Stop pattern detected - task completed successfully", {
      totalIterations: this.task.state.currentIteration,
    });
    // Clear consecutive error tracker on success
    this.updateState({
      status: "completed",
      completedAt: createTimestamp(),
      consecutiveErrors: undefined,
    });

    // Keep review-cycle comment state in sync before observers handle completion.
    if (this.task.state.reviewMode && this.task.state.reviewMode.reviewCycles > 0) {
      try {
        const addressedAt = new Date().toISOString();
        markCommentsAsAddressed(
          this.config.id,
          this.task.state.reviewMode.reviewCycles,
          addressedAt,
        );
        log.debug(`Marked comments as addressed for task ${this.config.id}, cycle ${this.task.state.reviewMode.reviewCycles}`);
      } catch (error) {
        log.error(`Failed to mark comments as addressed: ${String(error)}`);
      }
    }

    this.emit({
      type: "task.completed",
      taskId: this.config.id,
      totalIterations: this.task.state.currentIteration,
      timestamp: createTimestamp(),
    });

    // Persist immediately so callbacks (e.g., auto-push after conflict resolution)
    // can act on the completed status without waiting for the periodic persistence interval.
    await this.triggerPersistence();
    if (this.onCompleted) {
      queueMicrotask(() => {
        void this.onCompleted?.().catch(async (error) => {
          this.emitLog("error", `Automatic completion follow-up failed: ${String(error)}`);
          await this.triggerPersistence();
        });
      });
    }
    return true;
  }

  /**
   * Handle a "plan_ready" iteration outcome.
   * Reads plan content from the .clanky-planning folder, updates plan mode state,
   * emits the plan ready event, and exits the task (waits for user feedback).
   * Always returns true (task should exit).
   */
  private async handlePlanReadyOutcome(result: IterationResult): Promise<boolean> {
    this.emitLog("info", "Plan ready - waiting for user feedback or acceptance", {
      iteration: this.task.state.currentIteration,
    });

    // Read plan content from .clanky-planning/plan.md if possible
    let planContent: string | undefined;
    try {
      const planExecutor = await backendManager.getCommandExecutorAsync(this.config.workspaceId, this.workingDirectory);
      const planFilePath = getPlanFilePath(this.workingDirectory);
      const planFileExists = await planExecutor.fileExists(planFilePath);
      if (planFileExists) {
        planContent = await planExecutor.readFile(planFilePath) ?? undefined;
      }
    } catch {
      // Ignore errors reading plan file
    }
    const effectivePlanContent = planContent ?? result.responseContent;

    // Update plan mode state with the plan content, and clear consecutive
    // error tracker since this iteration succeeded (prevents stale error
    // context from leaking into subsequent plan feedback prompts).
    if (this.task.state.planMode) {
      log.trace(`[TaskEngine] runTask: Before updateState, isPlanReady:`, this.task.state.planMode.isPlanReady);
        this.updateState({
          planMode: {
            ...this.task.state.planMode,
            planContent: effectivePlanContent,
            isPlanReady: this.task.state.planMode.isPlanReady,
          },
          consecutiveErrors: undefined,
        });
      log.trace(`[TaskEngine] runTask: After updateState, isPlanReady:`, this.task.state.planMode?.isPlanReady);
    } else {
      // Even without planMode state, clear the error tracker on success
      this.updateState({ consecutiveErrors: undefined });
    }

    // Emit plan ready event
    this.emit({
      type: "task.plan.ready",
      taskId: this.config.id,
      planContent: effectivePlanContent,
      timestamp: createTimestamp(),
    });

    await this.triggerPersistence();

    if (this.task.config.autoAcceptPlan === true && this.onPlanReady) {
      this.emitLog("info", "Auto-accept plan enabled - continuing into execution");
      queueMicrotask(() => {
        void this.onPlanReady?.().catch(async (error) => {
          this.emitLog("error", `Auto-accepting the plan failed: ${String(error)}`);
          await this.triggerPersistence();
        });
      });
    }

    // Exit the task but stay in "planning" status
    // The task will be resumed when user sends feedback or accepts the plan
    return true;
  }

  /**
   * Handle an "error" iteration outcome.
   * Tracks consecutive errors and triggers failsafe exit if the limit is reached.
   * Returns true if the task should exit (failsafe), false to retry.
   */
  private async handleErrorOutcome(result: IterationResult): Promise<boolean> {
    const errorMessage = result.error ?? "Unknown error";

    // Error iterations don't count towards maxIterations - roll back the counter
    // This treats the error as a retry, not a completed iteration
    this.updateState({
      currentIteration: this.task.state.currentIteration - 1,
    });

    if (this.injectionPending) {
      return this.continueWithAbortFallbackInjection(errorMessage);
    }

    this.emitLog("error", `Iteration failed with error: ${errorMessage}`);

    // Track consecutive identical errors
    const shouldFailsafe = this.trackConsecutiveError(errorMessage, result.errorCode);

    if (shouldFailsafe) {
      const maxErrors = this.config.maxConsecutiveErrors ?? DEFAULT_TASK_CONFIG.maxConsecutiveErrors;
      this.emitLog("error", `Failsafe exit: ${maxErrors} consecutive identical errors`, {
        errorMessage,
      });
      this.updateState({
        status: "failed",
        completedAt: createTimestamp(),
        error: {
          message: `Failsafe: ${maxErrors} consecutive identical errors - ${errorMessage}`,
          iteration: this.task.state.currentIteration,
          timestamp: createTimestamp(),
        },
      });

      this.emit({
        type: "task.error",
        taskId: this.config.id,
        error: `Failsafe: ${maxErrors} consecutive identical errors - ${errorMessage}`,
        iteration: this.task.state.currentIteration,
        timestamp: createTimestamp(),
      });
      await this.triggerPersistence();
      return true;
    }

    // Log that we're continuing despite the error (as a retry)
    this.emitLog("warn", "Error occurred, retrying iteration", {
      errorMessage,
      consecutiveErrors: this.task.state.consecutiveErrors?.count ?? 1,
      maxConsecutiveErrors: this.config.maxConsecutiveErrors ?? "unlimited",
    });

    // Emit error event but don't stop
    this.emit({
      type: "task.error",
      taskId: this.config.id,
      error: errorMessage,
      iteration: this.task.state.currentIteration,
      timestamp: createTimestamp(),
    });
    void this.triggerPersistence();

    // Continue to retry (next iteration will use same iteration number)
    return false;
  }

  /**
   * Check if the task has reached the maximum iteration limit.
   * If so, updates state to "max_iterations", persists, emits event, and returns true.
   */
  private async hasReachedMaxIterations(): Promise<boolean> {
    if (
      this.config.maxIterations &&
      this.task.state.currentIteration >= this.config.maxIterations
    ) {
      this.emitLog("warn", `Reached maximum iterations limit: ${this.config.maxIterations}`);
      this.updateState({
        status: "max_iterations",
        completedAt: createTimestamp(),
      });

      this.emit({
        type: "task.stopped",
        taskId: this.config.id,
        reason: `Reached maximum iterations: ${this.config.maxIterations}`,
        timestamp: createTimestamp(),
      });
      await this.triggerPersistence();
      return true;
    }
    return false;
  }

  /**
   * Track consecutive identical errors.
   * Returns true if we should failsafe exit (max consecutive errors reached).
   * Returns false if maxConsecutiveErrors is undefined or 0 (unlimited).
   */
  private trackConsecutiveError(errorMessage: string, errorCode?: string): boolean {
    const tracker = this.task.state.consecutiveErrors;
    const maxErrors = this.config.maxConsecutiveErrors;
    const errorKey = errorCode ?? "unknown_error";

    // If maxErrors is undefined or 0, errors are unlimited - never failsafe
    if (maxErrors === undefined || maxErrors === 0) {
      // Still track the error count for logging purposes
      if (tracker && tracker.lastErrorCode === errorKey) {
        this.updateState({
          consecutiveErrors: {
            lastErrorMessage: errorMessage,
            lastErrorCode: errorKey,
            count: tracker.count + 1,
          },
        });
      } else {
        this.updateState({
          consecutiveErrors: {
            lastErrorMessage: errorMessage,
            lastErrorCode: errorKey,
            count: 1,
          },
        });
      }
      return false;
    }

    if (tracker && tracker.lastErrorCode === errorKey) {
      // Same error as before, increment count
      const newCount = tracker.count + 1;
      this.updateState({
        consecutiveErrors: {
          lastErrorMessage: errorMessage,
          lastErrorCode: errorKey,
          count: newCount,
        },
      });
      return newCount >= maxErrors;
    } else {
      // Different error or first error, reset tracker to 1
      this.updateState({
        consecutiveErrors: {
          lastErrorMessage: errorMessage,
          lastErrorCode: errorKey,
          count: 1,
        },
      });
      // Check if even 1 error exceeds the max (for maxConsecutiveErrors: 1 case)
      return 1 >= maxErrors;
    }
  }

  /**
   * Run a single iteration with real-time event streaming.
   */
  private async runIteration(): Promise<IterationResult> {
    log.debug("[TaskEngine] runIteration: Entry point");
    const iteration = this.task.state.currentIteration + 1;
    const startedAt = createTimestamp();

    // Check if we're in plan mode - need to check before updating status
    const isInPlanMode = this.task.state.status === "planning" && this.task.state.planMode?.active;

    this.emitLog("info", `Starting iteration ${iteration}`, {
      maxIterations: this.config.maxIterations,
    });

    // In plan mode, keep status as "planning"; otherwise set to "running"
    this.updateState({
      status: isInPlanMode ? "planning" : "running",
      currentIteration: iteration,
      lastActivityAt: startedAt,
    });

    this.emit({
      type: "task.iteration.start",
      taskId: this.config.id,
      iteration,
      timestamp: startedAt,
    });

    const ctx: IterationContext = {
      iteration,
      responseContent: "",
      reasoningContent: "",
      messageCount: 0,
      toolCallCount: 0,
      outcome: "continue",
      error: undefined,
      errorCode: undefined,
      currentMessageId: null,
      toolCalls: new Map(),
      currentResponseLogId: null,
      currentResponseLogContent: "",
      currentReasoningLogId: null,
      currentReasoningLogContent: "",
    };

    try {
      // Build and send prompt, then process the event stream
      await this.executeIterationPrompt(ctx);

      if (this.aborted && ctx.errorCode === "acp_request_cancelled") {
        ctx.outcome = "continue";
        ctx.error = undefined;
      }

      // Evaluate whether the response matches a stop/completion pattern
      this.evaluateOutcome(ctx);

      // Commit changes after iteration
      if (ctx.outcome !== "error") {
        this.emitLog("info", "Checking for changes to commit...");
        await this.commitIteration(iteration, ctx.responseContent);
      }
    } catch (err) {
      ctx.outcome = "error";
      ctx.error = getAcpErrorMessage(err);
      ctx.errorCode = err instanceof AcpError ? err.code : undefined;
      this.emitLog("error", `Iteration error: ${ctx.error}`);
    }

    return this.buildIterationResult(ctx, startedAt);
  }

  /**
   * Send the prompt to the AI backend and process all events from the response stream.
   * Handles subscribing to the event stream, sending the prompt, and iterating
   * through all agent events until the message completes or an error occurs.
   */
  private async executeIterationPrompt(ctx: IterationContext): Promise<void> {
    await this.activeSessionInterrupt;

    if (!this.sessionId || !this.backend.isConnected()) {
      this.emitLog("info", "AI session is unavailable - reconnecting before continuing", {
        hasSessionId: this.sessionId !== null,
        connected: this.backend.isConnected(),
      });
      await this.reconnectSession();
    }

    // Handle pending model change via ACP config options (works for all agents)
    await this.handlePendingModelChange();

    // Build the prompt
    log.debug("[TaskEngine] runIteration: Building prompt");
    this.emitLog("debug", "Building prompt for AI agent");
    const prompt = this.buildPrompt(ctx.iteration);

    // Log the prompt for debugging
    log.debug("[TaskEngine] runIteration: Prompt details", {
      partsCount: prompt.parts.length,
      model: prompt.model ? `${prompt.model.providerID}/${prompt.model.modelID}` : "default",
      textLength: prompt.parts[0]?.type === "text" ? prompt.parts[0].text.length : 0,
      textPreview: prompt.parts[0]?.type === "text" ? prompt.parts[0].text.slice(0, 200) : "",
    });

    // Log the exact prompt text to the log viewer at debug level
    const fullPromptText = prompt.parts
      .map((part) => {
        if (part.type === "image") {
          return `[image:${part.mimeType}]`;
        }
        if (part.type === "resource") {
          return `[resource:${part.resource.mimeType ?? "application/octet-stream"}]`;
        }
        return part.text;
      })
      .join("\n---\n");
    this.emitLog("debug", `[Prompt] ${fullPromptText}`);

    let hasRetriedMissingSession = false;
    let completed = false;

    while (!completed) {
      if (!this.sessionId) {
        throw new Error("No session ID");
      }
      const activeSessionId = this.sessionId;

      const activityTimeoutSeconds =
        this.config.activityTimeoutSeconds ?? DEFAULT_TASK_CONFIG.activityTimeoutSeconds;
      const streamController = new AgentStreamController(this.backend);
      let streamHandle: AgentStreamHandle | null = null;
      try {
        // The shared controller subscribes before sending the prompt and owns
        // stream cleanup for both chat and task turns.
        log.debug("[TaskEngine] runIteration: Starting shared agent stream");
        this.emitLog("debug", "Subscribing to AI response stream");
        this.emitLog("info", "Sending prompt to AI agent...");
        streamHandle = streamController.start({
          sessionId: activeSessionId,
          prompt,
          activityTimeoutMs: activityTimeoutSeconds === null
            ? null
            : activityTimeoutSeconds * 1000,
        });
        this.currentStreamHandle = streamHandle;
        const started = await streamHandle.startPrompt();
        if (!started) {
          completed = true;
          continue;
        }
        log.debug("[TaskEngine] runIteration: Subscription established, got event stream");
        log.debug("[TaskEngine] runIteration: About to start event iteration task");
        let abortLogged = false;
        await streamHandle.consume({
          shouldStop: () => {
            if (!this.aborted) {
              return false;
            }
            if (!abortLogged) {
              abortLogged = true;
              if (this.injectionPending) {
                this.emitLog("info", "Iteration interrupted for pending message injection");
              } else {
                this.emitLog("info", "Iteration aborted by user");
              }
            }
            return true;
          },
          onEvent: async (event) => {
            log.trace("[TaskEngine] runIteration: Received event", { type: event.type });

            // Update last activity timestamp
            this.updateState({ lastActivityAt: createTimestamp() });

            // Delegate event processing to the handler
            await this.processAgentEvent(event, ctx);

            if (event.type === "error" && event.code === "acp_session_not_found") {
              throw createAcpSessionNotFoundError(activeSessionId, {
                details: { eventMessage: event.message },
              });
            }

            // The shared controller stops after message.complete/error.
            if (event.type === "message.complete" || event.type === "error") {
              this.emitLog("debug", `Breaking out of event stream: ${event.type}`);
            }
          },
        });

        completed = true;
      } catch (error) {
        if (!hasRetriedMissingSession && isAcpErrorCode(error, "acp_session_not_found")) {
          hasRetriedMissingSession = true;
          const message = getAcpErrorMessage(error);
          this.emitLog("warn", "Session not found during prompt execution - recreating session and retrying once", {
            sessionId: activeSessionId,
            error: message,
          });
          await this.recreateSessionAfterSessionLoss(message);
          this.resetIterationContextForRetry(ctx);
          continue;
        }

        throw error;
      } finally {
        streamHandle?.close();
        if (this.currentStreamHandle === streamHandle) {
          this.currentStreamHandle = null;
        }
      }
    }

    this.emitLog("debug", "Exited event stream task", { outcome: ctx.outcome, error: ctx.error });
  }

  /**
   * Emit a user message so it appears in the conversation thread.
   * Persists the message with role "user" in task.state.messages and
   * emits a task.message event for real-time WebSocket delivery.
   *
   * Uses a deterministic ID so that retries of the same iteration
   * (after transient errors) do not create duplicate messages —
   * persistMessage() deduplicates by ID.
   *
   * @param content - The user message content to log
   * @param idSuffix - Optional suffix for the deterministic message ID.
   *                   Defaults to the current iteration number.
   */
  private consumeInitialPromptAttachments(): MessageImageAttachment[] {
    const attachments = this.initialPromptAttachments;
    this.initialPromptAttachments = [];
    return attachments;
  }

  private consumePendingPromptAttachments(): MessageImageAttachment[] {
    const attachments = this.pendingPromptAttachments;
    this.pendingPromptAttachments = [];
    return attachments;
  }

  private emitUserMessage(
    content: string,
    idSuffix?: string,
    attachments: MessageImageAttachment[] = [],
  ): void {
    const suffix = idSuffix ?? `iter-${this.task.state.currentIteration}`;
    const messageData: MessageData = {
      id: `user-msg-${this.config.id}-${suffix}`,
      role: "user",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: createTimestamp(),
    };
    this.persistMessage(messageData);
    this.emit({
      type: "task.message",
      taskId: this.config.id,
      iteration: this.task.state.currentIteration,
      message: messageData,
      timestamp: createTimestamp(),
    });
    // Also log to server console for observability
    const taskPrefix = `[Task:${this.config.name}]`;
    const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
    log.info(`${taskPrefix} [user] ${preview}`);
  }

  /**
   * Build the final IterationResult from the iteration context.
   * Records the iteration summary, emits completion events, and persists state.
   */
  private async buildIterationResult(ctx: IterationContext, startedAt: string): Promise<IterationResult> {
    const completedAt = createTimestamp();

    // Record iteration summary
    const summary: IterationSummary = {
      iteration: ctx.iteration,
      startedAt,
      completedAt,
      messageCount: ctx.messageCount,
      toolCallCount: ctx.toolCallCount,
      outcome: ctx.outcome,
    };

    this.updateState({
      lastActivityAt: completedAt,
      recentIterations: [...this.task.state.recentIterations.slice(-9), summary],
    });

    this.emitLog("info", `Iteration ${ctx.iteration} completed`, {
      outcome: ctx.outcome,
      messageCount: ctx.messageCount,
      toolCallCount: ctx.toolCallCount,
    });

    this.emit({
      type: "task.iteration.end",
      taskId: this.config.id,
      iteration: ctx.iteration,
      outcome: ctx.outcome,
      timestamp: completedAt,
    });

    // Persist non-terminal iteration state immediately. Terminal and plan-ready
    // outcomes persist after their state transitions are applied so finalization
    // cannot get stuck after the response has already been streamed.
    if (ctx.outcome === "continue") {
      await this.triggerPersistence();
    }

    return {
      continue: ctx.outcome === "continue",
      outcome: ctx.outcome,
      responseContent: ctx.responseContent,
      error: ctx.error,
      errorCode: ctx.errorCode,
      messageCount: ctx.messageCount,
      toolCallCount: ctx.toolCallCount,
    };
  }

  /**
   * Check if the task should continue running.
   */
  private shouldContinue(): boolean {
    const status = this.task.state.status;
    const isActive = status === "running" || status === "starting" || status === "planning";
    if (!isActive) {
      return false;
    }
    return true;
  }

  /**
   * Handle an error during task execution.
   */
  private handleError(error: unknown): void {
    const message = String(error);

    this.updateState({
      status: "failed",
      completedAt: createTimestamp(),
      error: {
        message,
        iteration: this.task.state.currentIteration,
        timestamp: createTimestamp(),
      },
    });

    this.emit({
      type: "task.error",
      taskId: this.config.id,
      error: message,
      iteration: this.task.state.currentIteration,
      timestamp: createTimestamp(),
    });
  }

  /**
   * Update the task state.
   * Validates status transitions against the state machine when a status change is included.
   */
  private updateState(update: Partial<TaskState>): void {
    if (update.status !== undefined && update.status !== this.task.state.status) {
      assertValidTransition(this.task.state.status, update.status, "TaskEngine.updateState");
    }
    Object.assign(this.task.state, update);
  }

  /**
   * Trigger disk persistence of the current state.
   * This is called at key points to ensure data survives server restart.
   */
  private async triggerPersistence(): Promise<void> {
    if (this.onPersistState) {
      try {
        await this.onPersistState(this.task.state);
      } catch (error) {
        log.error(`Failed to persist task state: ${String(error)}`);
      }
    }
  }

  /**
   * Emit a task event.
   */
  private emit(event: TaskEvent): void {
    this.emitter.emit(event);
  }
}
