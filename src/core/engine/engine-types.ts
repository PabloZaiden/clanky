/**
 * Shared types and constants for TaskEngine internals.
 */

import type { AcpBackend } from "../../backends/acp";
import type { AgentStreamBackend } from "../agent-stream-controller";
import type {
  TaskConfig,
  TaskState,
  Task,
  TaskLogEntry,
  ModelConfig,
  TranscriptChangeSet,
  TaskPromptIntent,
} from "@/shared";
import type { TaskEvent } from "@/shared/events";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import type { PromptInput } from "../../backends/types";
import type { GitService } from "../git";
import type { SimpleEventEmitter } from "../event-emitter";

/**
 * Maximum number of log entries to persist in task state.
 * When exceeded, the oldest entries are evicted to keep memory bounded.
 * The frontend loads the last 1000 on page refresh, so 5000 provides
 * ample history while preventing unbounded growth.
 */
export const MAX_PERSISTED_LOGS = 5000;

/**
 * Maximum number of messages to persist in task state.
 * Messages are larger than logs due to AI response content.
 */
export const MAX_PERSISTED_MESSAGES = 2000;

/**
 * Maximum number of tool calls to persist in task state.
 */
export const MAX_PERSISTED_TOOL_CALLS = 5000;

/**
 * Controls the default execution policy for prompts without an explicit
 * direct-user origin. A prompt marked as direct_user always runs as one turn,
 * even when the engine's default policy is task_loop.
 */
export type TaskExecutionPolicy = "task_loop" | "single_turn";

export interface SessionReconnectResult {
  sessionId: string;
  reusedExisting: boolean;
  createdNew: boolean;
}

export interface SessionInterruptOptions {
  abortMessage: string;
  abortWarnMessage: string;
  forceDisconnect: boolean;
  /**
   * Close the local stream before aborting the backend session. Injection keeps
   * the stream open so the backend's abort semantics preserve the pending
   * values until the next turn is actually ready.
   */
  closeStream?: boolean;
  disconnectMessage?: string;
  disconnectWarnMessage?: string;
}

/**
 * Typed boundary for backend connection and ACP session ownership.
 */
export interface TaskSessionLifecycle {
  readonly sessionId: string | null;
  isConnected(): boolean;
  waitForInterrupt(): Promise<void>;
  setup(): Promise<string>;
  reconnect(): Promise<SessionReconnectResult>;
  ensureSession(): Promise<void>;
  recreateAfterLoss(reason: string): Promise<string>;
  handlePendingModelChange(): Promise<void>;
  consumeSessionRecovery(): boolean;
  interruptSession(options: SessionInterruptOptions): Promise<void>;
}

export interface TaskPromptBuildResult {
  prompt: PromptInput;
  promptMode: TaskPromptIntent;
}

export interface TaskPromptExecutionOptions {
  buildPrompt: () => TaskPromptBuildResult;
}

/**
 * Typed boundary for one prompt turn and its stream/recovery resources.
 */
export interface TaskPromptExecutor {
  execute(
    ctx: IterationContext,
    options: TaskPromptExecutionOptions,
  ): Promise<TaskPromptBuildResult>;
  interrupt(options: SessionInterruptOptions): Promise<void>;
}

/**
 * Backend interface for TaskEngine.
 * This is a structural type that defines the methods TaskEngine needs.
 * Both AcpBackend and MockAcpBackend satisfy this interface.
 * Using a structural type (interface) instead of a union allows for
 * easy mocking in tests without requiring all internal class fields.
 */
export interface TaskBackend extends AgentStreamBackend {
  connect: AcpBackend["connect"];
  disconnect: AcpBackend["disconnect"];
  isConnected: AcpBackend["isConnected"];
  createSession: AcpBackend["createSession"];
  sendPrompt: AcpBackend["sendPrompt"];
  abortSession: AcpBackend["abortSession"];
  replyToPermission: AcpBackend["replyToPermission"];
  replyToQuestion: AcpBackend["replyToQuestion"];
  setConfigOption: AcpBackend["setConfigOption"];
  setSessionModel: AcpBackend["setSessionModel"];
}

/**
 * Options for creating a TaskEngine.
 */
export interface TaskEngineOptions {
  /** The task configuration and state */
  task: Task;
  /** The agent backend to use */
  backend: TaskBackend;
  /** Git service instance (required) */
  gitService: GitService;
  /** Event emitter instance (optional, defaults to global) */
  eventEmitter?: SimpleEventEmitter<TaskEvent>;
  /** Callback to persist state to disk (optional) */
  onPersistState?: (
    state: TaskState,
    options: { transcriptChanges: TranscriptChangeSet },
  ) => Promise<void>;
  /** Callback fired after a plan becomes ready (optional) */
  onPlanReady?: () => Promise<void>;
  /** Callback fired after a task reaches completed status (optional) */
  onCompleted?: () => Promise<void>;
  /** Skip git branch setup (for review cycles where branch is already set up) */
  skipGitSetup?: boolean;
  /** Reuse the persisted ACP session when restarting an existing task. */
  reuseExistingSession?: boolean;
  /** Execution policy used when start() or continueExecution() runs the engine. */
  executionPolicy?: TaskExecutionPolicy;
  /** Transient attachments for the first prompt sent by this engine */
  initialPromptAttachments?: MessageImageAttachment[];
}

/**
 * Result of running an iteration.
 */
export interface IterationResult {
  /** Whether the task should continue */
  continue: boolean;
  /** Origin of the prompt that produced this iteration */
  promptMode: TaskPromptIntent;
  /** The outcome of this iteration */
  outcome: "continue" | "complete" | "blocked" | "error" | "plan_ready";
  /** The full response content from the AI */
  responseContent: string;
  /** Error message if outcome is "error" */
  error?: string;
  /** Stable error code if outcome is "error" */
  errorCode?: string;
  /** Number of messages received */
  messageCount: number;
  /** Number of tool calls made */
  toolCallCount: number;
}

/**
 * Mutable context passed through a single iteration.
 * Groups the per-iteration tracking state that processAgentEvent() and
 * evaluateOutcome() need to read and write.
 */
export interface IterationContext {
  iteration: number;
  responseContent: string;
  reasoningContent: string;
  messageCount: number;
  toolCallCount: number;
  outcome: IterationResult["outcome"];
  error: string | undefined;
  errorCode: string | undefined;
  currentMessageId: string | null;
  toolCalls: Map<string, { id: string; name: string; input: unknown }>;
  /** ID of the current streaming response log entry (for delta combining) */
  currentResponseLogId: string | null;
  currentResponseLogContent: string;
  /** ID of the current streaming reasoning log entry (for delta combining) */
  currentReasoningLogId: string | null;
  currentReasoningLogContent: string;
}

// Re-export task types used by engine consumers so they don't have to reach into types/task
export type { TaskConfig, TaskState, Task, TaskLogEntry, ModelConfig };
