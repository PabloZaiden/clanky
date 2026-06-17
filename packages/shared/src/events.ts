/**
 * Event type definitions for Clanky Tasks Management System.
 * 
 * These types define the events emitted during task execution and streamed
 * to connected clients via WebSocket. Events follow a consistent structure:
 * - `type`: Event identifier (always prefixed with "task.")
 * - `taskId`: The task this event belongs to
 * - `timestamp`: ISO 8601 timestamp when the event occurred
 * 
 * Events are used for:
 * - Real-time UI updates (progress, messages, tool calls)
 * - State synchronization across browser tabs
 * - Activity logging and debugging
 * 
 * @module types/events
 */

import type { Agent, AgentRun, AgentRunStatus } from "./agent";
import type { Chat, ChatConfig, ChatStatus } from "./chat";
import type { AutomaticPrFlowState, GitCommit, TaskConfig, TaskLogEntry, ModelConfig } from "./task";
import type { MessageImageAttachment } from "./message-attachments";
import type { ToolCallExtra, ToolCallRecord } from "./tool-call";

/**
 * Message data from the AI agent.
 * 
 * Represents a single message in the conversation between the user prompt
 * and the AI assistant. Messages are streamed during iteration execution.
 * 
 * @example
 * ```typescript
 * const message: MessageData = {
 *   id: "msg_123",
 *   role: "assistant",
 *   content: "I'll start by reading the package.json file...",
 *   timestamp: "2025-01-27T10:30:00.000Z"
 * };
 * ```
 */
export interface MessageData {
  /** Unique message identifier (from the backend) */
  id: string;
  /** Role: "user" for prompts, "assistant" for AI responses */
  role: "user" | "assistant";
  /** The message content (may contain markdown) */
  content: string;
  /** Inline image attachments carried with the message for live updates and refresh recovery */
  attachments?: MessageImageAttachment[];
  /** ISO 8601 timestamp when the message was created */
  timestamp: string;
}

/**
 * Tool call data from the AI agent.
 * 
 * Represents a tool invocation by the AI during iteration execution.
 * Tool calls go through states: pending -> running -> completed/failed.
 * The same tool call ID is emitted multiple times as its status changes.
 * Persisted backend `name` values may be coarse categories, so UI rendering
 * should prefer inferring the concrete tool kind from the raw `input` shape.
 * 
 * @example
 * ```typescript
 * const toolCall: ToolCallData = {
 *   id: "tool_456",
 *   name: "Write",
 *   input: { filePath: "/src/index.ts", content: "..." },
 *   status: "completed",
 *   output: { success: true },
 *   timestamp: "2025-01-27T10:30:05.000Z"
 * };
 * ```
 */
export interface ToolCallData extends ToolCallRecord {}

/**
 * Union type of all possible task events.
 * 
 * These events are streamed via WebSocket to connected clients for real-time
 * updates. Each event type corresponds to a specific state change or activity
 * in the task lifecycle.
 * 
 * Event categories:
 * - **Lifecycle events**: created, started, completed, stopped, session_aborted, error, deleted, merged
 * - **Iteration events**: iteration.start, iteration.end
 * - **Activity events**: message, tool_call, progress, log, git.commit
 * - **Completion events**: accepted (kept locally), merged (detected externally), discarded, pushed
 * - **Sync events**: sync.started, sync.clean, sync.conflicts, sync.failed
 * - **Plan mode events**: plan.ready, plan.feedback, plan.accepted, plan.discarded
 * - **State events**: pending.updated, automatic_pr_flow.updated
 */
export type TaskEvent =
  | TaskCreatedEvent
  | TaskStartedEvent
  | TaskIterationStartEvent
  | TaskIterationEndEvent
  | TaskMessageEvent
  | TaskToolCallEvent
  | TaskToolCallExtraEvent
  | TaskProgressEvent
  | TaskLogEvent
  | TaskGitCommitEvent
  | TaskCompletedEvent
  | TaskSshHandoffEvent
  | TaskStoppedEvent
  | TaskSessionAbortedEvent
  | TaskErrorEvent
  | TaskDeletedEvent
  | TaskMergedEvent
  | TaskAcceptedEvent
  | TaskDiscardedEvent
  | TaskPushedEvent
  | TaskSyncStartedEvent
  | TaskSyncCleanEvent
  | TaskSyncConflictsEvent
  | TaskSyncFailedEvent
  | TaskPlanReadyEvent
  | TaskPlanFeedbackSentEvent
  | TaskPlanAcceptedEvent
  | TaskPlanDiscardedEvent
  | TaskPendingUpdatedEvent
  | TaskAutomaticPrFlowUpdatedEvent;

/**
 * Union type of all chat-scoped events streamed to clients.
 */
export type ChatEvent =
  | ChatCreatedEvent
  | ChatUpdatedEvent
  | ChatStatusEvent
  | ChatMessageEvent
  | ChatToolCallEvent
  | ChatToolCallExtraEvent
  | ChatLogEvent
  | ChatInterruptedEvent
  | ChatErrorEvent
  | ChatDeletedEvent;

/**
 * Union type of all agent-scoped events streamed to clients.
 */
export type AgentEvent =
  | AgentCreatedEvent
  | AgentUpdatedEvent
  | AgentDeletedEvent
  | AgentRunScheduledEvent
  | AgentRunStartedEvent
  | AgentRunStatusEvent
  | AgentRunMessageEvent
  | AgentRunToolCallEvent
  | AgentRunToolCallExtraEvent
  | AgentRunLogEvent
  | AgentRunSkippedEvent
  | AgentRunCompletedEvent
  | AgentRunFailedEvent
  | AgentRunInterruptedEvent
  | AgentRunDeletedEvent
  | AgentRunsPurgedEvent;

export interface ChatCreatedEvent {
  type: "chat.created";
  chatId: string;
  config: ChatConfig;
  timestamp: string;
}

export interface ChatUpdatedEvent {
  type: "chat.updated";
  chatId: string;
  chat: Chat;
  timestamp: string;
}

export interface ChatStatusEvent {
  type: "chat.status";
  chatId: string;
  status: ChatStatus;
  timestamp: string;
}

export interface ChatMessageEvent {
  type: "chat.message";
  chatId: string;
  scope: ChatConfig["scope"];
  message: MessageData;
  timestamp: string;
}

export interface ChatToolCallEvent {
  type: "chat.tool_call";
  chatId: string;
  scope: ChatConfig["scope"];
  tool: ToolCallData;
  timestamp: string;
}

export interface ChatToolCallExtraEvent {
  type: "chat.tool_call.extra";
  chatId: string;
  scope: ChatConfig["scope"];
  toolId: string;
  extra: ToolCallExtra;
  timestamp: string;
}

export interface ChatLogEvent {
  type: "chat.log";
  chatId: string;
  scope: ChatConfig["scope"];
  log: TaskLogEntry;
  timestamp: string;
}

export interface ChatInterruptedEvent {
  type: "chat.interrupted";
  chatId: string;
  timestamp: string;
}

export interface ChatErrorEvent {
  type: "chat.error";
  chatId: string;
  message: string;
  timestamp: string;
}

export interface ChatDeletedEvent {
  type: "chat.deleted";
  chatId: string;
  timestamp: string;
}

export interface AgentCreatedEvent {
  type: "agent.created";
  agentId: string;
  agent: Agent;
  timestamp: string;
}

export interface AgentUpdatedEvent {
  type: "agent.updated";
  agentId: string;
  agent: Agent;
  timestamp: string;
}

export interface AgentDeletedEvent {
  type: "agent.deleted";
  agentId: string;
  timestamp: string;
}

export interface AgentRunScheduledEvent {
  type: "agent.run.scheduled";
  agentId: string;
  agentRunId: string;
  run: AgentRun;
  timestamp: string;
}

export interface AgentRunStartedEvent {
  type: "agent.run.started";
  agentId: string;
  agentRunId: string;
  run: AgentRun;
  timestamp: string;
}

export interface AgentRunStatusEvent {
  type: "agent.run.status";
  agentId: string;
  agentRunId: string;
  status: AgentRunStatus;
  timestamp: string;
}

export interface AgentRunMessageEvent {
  type: "agent.run.message";
  agentId: string;
  agentRunId: string;
  message: MessageData;
  timestamp: string;
}

export interface AgentRunToolCallEvent {
  type: "agent.run.tool_call";
  agentId: string;
  agentRunId: string;
  tool: ToolCallData;
  timestamp: string;
}

export interface AgentRunToolCallExtraEvent {
  type: "agent.run.tool_call.extra";
  agentId: string;
  agentRunId: string;
  toolId: string;
  extra: ToolCallExtra;
  timestamp: string;
}

export interface AgentRunLogEvent {
  type: "agent.run.log";
  agentId: string;
  agentRunId: string;
  log: TaskLogEntry;
  timestamp: string;
}

export interface AgentRunSkippedEvent {
  type: "agent.run.skipped";
  agentId: string;
  agentRunId: string;
  reason: string;
  timestamp: string;
}

export interface AgentRunCompletedEvent {
  type: "agent.run.completed";
  agentId: string;
  agentRunId: string;
  run: AgentRun;
  timestamp: string;
}

export interface AgentRunFailedEvent {
  type: "agent.run.failed";
  agentId: string;
  agentRunId: string;
  message: string;
  timestamp: string;
}

export interface AgentRunInterruptedEvent {
  type: "agent.run.interrupted";
  agentId: string;
  agentRunId: string;
  timestamp: string;
}

export interface AgentRunDeletedEvent {
  type: "agent.run.deleted";
  agentId: string;
  agentRunId: string;
  timestamp: string;
}

export interface AgentRunsPurgedEvent {
  type: "agent.runs.purged";
  agentId: string;
  deletedRunIds: string[];
  timestamp: string;
}

/**
 * Emitted when a new task is created.
 * Contains the full configuration for the new task.
 */
export interface TaskCreatedEvent {
  type: "task.created";
  /** ID of the newly created task */
  taskId: string;
  /** Full configuration of the task */
  config: TaskConfig;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task starts execution.
 * This occurs after git branch setup and backend connection are established.
 */
export interface TaskStartedEvent {
  type: "task.started";
  /** ID of the task that started */
  taskId: string;
  /** Iteration number (usually 1 for initial start) */
  iteration: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted at the beginning of each iteration.
 * An iteration is one complete prompt-response cycle with the AI.
 */
export interface TaskIterationStartEvent {
  type: "task.iteration.start";
  /** ID of the task */
  taskId: string;
  /** Iteration number (1-based) */
  iteration: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted at the end of each iteration.
 * Contains the outcome which determines what happens next.
 */
export interface TaskIterationEndEvent {
  type: "task.iteration.end";
  /** ID of the task */
  taskId: string;
  /** Iteration number (1-based) */
  iteration: number;
  /** 
   * How the iteration ended:
   * - "continue": More work needed, will start next iteration
   * - "complete": Stop pattern matched, task is done
   * - "error": An error occurred during iteration
   * - "plan_ready": Plan mode completed, awaiting approval
   */
  outcome: "continue" | "complete" | "error" | "plan_ready";
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when an AI message is received.
 * Messages are streamed incrementally during iteration execution.
 */
export interface TaskMessageEvent {
  type: "task.message";
  /** ID of the task */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** The message data */
  message: MessageData;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a tool call is made or updated.
 * The same tool call ID may be emitted multiple times as status changes.
 */
export interface TaskToolCallEvent {
  type: "task.tool_call";
  /** ID of the task */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** The tool call data */
  tool: ToolCallData;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a new persisted extra is attached to an existing tool call.
 */
export interface TaskToolCallExtraEvent {
  type: "task.tool_call.extra";
  /** ID of the task */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** Tool call ID that owns the extra */
  toolId: string;
  /** The attached extra payload */
  extra: ToolCallExtra;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted for streaming progress updates.
 * Used for partial content that doesn't form complete messages yet.
 */
export interface TaskProgressEvent {
  type: "task.progress";
  /** ID of the task */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** Partial content being streamed */
  content: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Log levels for task events.
 * - "agent": AI agent activity (prompts, responses, tool calls)
 * - "user": User-injected messages (mid-task messages from the user)
 * - "info": General informational messages
 * - "warn": Warning messages
 * - "error": Error messages
 * - "debug": Debug/verbose messages
 * - "trace": Very verbose trace messages (AI streaming, internal details)
 */
export type LogLevel = "agent" | "user" | "info" | "warn" | "error" | "debug" | "trace";

/**
 * Application-level log event.
 * Used to communicate what the task engine is doing internally.
 */
export interface TaskLogEvent {
  type: "task.log";
  taskId: string;
  /** Unique ID for this log entry (used for updates) */
  id: string;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Optional additional details */
  details?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Emitted when a git commit is created during task execution.
 * The AI agent may create commits after making file changes.
 */
export interface TaskGitCommitEvent {
  type: "task.git.commit";
  /** ID of the task */
  taskId: string;
  /** Iteration number when the commit was made */
  iteration: number;
  /** Git commit details */
  commit: GitCommit;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task completes successfully.
 * This occurs when the stop pattern is matched in the AI response.
 */
export interface TaskCompletedEvent {
  type: "task.completed";
  /** ID of the task that completed */
  taskId: string;
  /** Total number of iterations executed */
  totalIterations: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a plan is accepted and control is handed off directly via SSH.
 * This path skips autonomous execution while moving the task to a completed state.
 */
export interface TaskSshHandoffEvent {
  type: "task.ssh_handoff";
  /** ID of the task that was handed off */
  taskId: string;
  /** Total number of iterations executed before the handoff */
  totalIterations: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task is manually stopped by the user.
 */
export interface TaskStoppedEvent {
  type: "task.stopped";
  /** ID of the task that was stopped */
  taskId: string;
  /** Reason for stopping (e.g., "User requested stop") */
  reason: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task's session is aborted without changing status.
 * Used during connection resets to clean up backend resources while
 * preserving the task's current state (e.g., planning tasks stay in planning).
 */
export interface TaskSessionAbortedEvent {
  type: "task.session_aborted";
  /** ID of the task whose session was aborted */
  taskId: string;
  /** Reason for the session abort (e.g., "Connection reset requested") */
  reason: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when an error occurs during task execution.
 * The task may retry or fail depending on the error type and retry count.
 */
export interface TaskErrorEvent {
  type: "task.error";
  /** ID of the task that errored */
  taskId: string;
  /** Error message */
  error: string;
  /** Iteration number when the error occurred */
  iteration: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task is deleted.
 * The task's git branch may or may not be deleted depending on user choice.
 */
export interface TaskDeletedEvent {
  type: "task.deleted";
  /** ID of the deleted task */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task is marked as merged after the merge happened externally
 * (for example via a pull request on GitHub).
 */
export interface TaskMergedEvent {
  type: "task.merged";
  /** ID of the task that was merged */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task's committed changes are accepted locally without pushing.
 */
export interface TaskAcceptedEvent {
  type: "task.accepted";
  /** ID of the task that was accepted */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task's changes are discarded.
 * The working branch is deleted and changes are lost.
 */
export interface TaskDiscardedEvent {
  type: "task.discarded";
  /** ID of the task that was discarded */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a task's branch is pushed to a remote repository.
 * The task enters "pushed" status and can receive reviewer comments.
 */
export interface TaskPushedEvent {
  type: "task.pushed";
  /** ID of the task that was pushed */
  taskId: string;
  /** Name of the remote branch (e.g., "origin/add-feature-a1b2c3d") */
  remoteBranch: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a base branch sync starts during push.
 * Indicates the system is fetching and merging the latest base branch.
 */
export interface TaskSyncStartedEvent {
  type: "task.sync.started";
  /** ID of the task being synced */
  taskId: string;
  /** The base branch being synced with */
  baseBranch: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a base branch sync completes cleanly (no conflicts).
 * The merge succeeded and push will proceed immediately.
 */
export interface TaskSyncCleanEvent {
  type: "task.sync.clean";
  /** ID of the task that was synced */
  taskId: string;
  /** The base branch that was synced with */
  baseBranch: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a base branch sync detects merge conflicts.
 * The task engine is being restarted to resolve the conflicts.
 */
export interface TaskSyncConflictsEvent {
  type: "task.sync.conflicts";
  /** ID of the task with conflicts */
  taskId: string;
  /** The base branch that caused conflicts */
  baseBranch: string;
  /** List of files with conflicts */
  conflictedFiles: string[];
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a base branch sync cannot complete.
 * The task remains blocked until the failure is surfaced or retried explicitly.
 */
export interface TaskSyncFailedEvent {
  type: "task.sync.failed";
  /** ID of the task whose sync failed */
  taskId: string;
  /** The base branch that could not be synced */
  baseBranch: string;
  /** Human-readable failure reason */
  error: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when plan mode completes and a plan is ready for review.
 * The user can approve, provide feedback, or discard the plan.
 */
export interface TaskPlanReadyEvent {
  type: "task.plan.ready";
  /** ID of the task in planning mode */
  taskId: string;
  /** The generated plan content (markdown) */
  planContent: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when the user sends feedback on a plan.
 * The AI will revise the plan based on the feedback.
 */
export interface TaskPlanFeedbackSentEvent {
  type: "task.plan.feedback";
  /** ID of the task */
  taskId: string;
  /** Feedback round number (1-based) */
  round: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a plan is accepted.
 * The task transitions from "planning" to either "running" or "completed",
 * depending on whether execution starts immediately or control is handed off via SSH.
 */
export interface TaskPlanAcceptedEvent {
  type: "task.plan.accepted";
  /** ID of the task */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when a plan is discarded.
 * The task returns to draft status without executing.
 */
export interface TaskPlanDiscardedEvent {
  type: "task.plan.discarded";
  /** ID of the task */
  taskId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when pending values (prompt or model) are updated.
 * Used for real-time UI updates when the next message/model override changes.
 */
export interface TaskPendingUpdatedEvent {
  type: "task.pending.updated";
  /** ID of the task */
  taskId: string;
  /** Pending prompt (if set, undefined if cleared) */
  pendingPrompt?: string;
  /** Pending model (if set, undefined if cleared) */
  pendingModel?: ModelConfig;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Emitted when the persisted automatic PR flow state changes.
 * Used by the UI to refresh pushed-task state after automation is enabled,
 * disabled, or transitions between feedback-handling phases.
 */
export interface TaskAutomaticPrFlowUpdatedEvent {
  type: "task.automatic_pr_flow.updated";
  /** ID of the task */
  taskId: string;
  /** Latest automatic PR flow state after persistence */
  automaticPrFlow?: AutomaticPrFlowState;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Creates an ISO 8601 timestamp for event creation.
 * 
 * @returns Current time as ISO 8601 string (e.g., "2025-01-27T10:30:00.000Z")
 * 
 * @example
 * ```typescript
 * const event: TaskCreatedEvent = {
 *   type: "task.created",
 *   taskId: "abc-123",
 *   config: taskConfig,
 *   timestamp: createTimestamp()
 * };
 * ```
 */
export function createTimestamp(): string {
  return new Date().toISOString();
}
