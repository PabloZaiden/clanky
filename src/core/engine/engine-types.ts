/**
 * Shared types and constants for LoopEngine internals.
 */

import type { AcpBackend } from "../../backends/acp";
import type {
  LoopConfig,
  LoopState,
  Loop,
  LoopLogEntry,
  ModelConfig,
} from "../../types/loop";
import type { LoopEvent } from "../../types/events";
import type { MessageImageAttachment } from "../../types/message-attachments";
import type { GitService } from "../git-service";
import type { SimpleEventEmitter } from "../event-emitter";

/**
 * Maximum number of log entries to persist in loop state.
 * When exceeded, the oldest entries are evicted to keep memory bounded.
 * The frontend loads the last 1000 on page refresh, so 5000 provides
 * ample history while preventing unbounded growth.
 */
export const MAX_PERSISTED_LOGS = 5000;

/**
 * Maximum number of messages to persist in loop state.
 * Messages are larger than logs due to AI response content.
 */
export const MAX_PERSISTED_MESSAGES = 2000;

/**
 * Maximum number of tool calls to persist in loop state.
 */
export const MAX_PERSISTED_TOOL_CALLS = 5000;

/**
 * Backend interface for LoopEngine.
 * This is a structural type that defines the methods LoopEngine needs.
 * Both AcpBackend and MockAcpBackend satisfy this interface.
 * Using a structural type (interface) instead of a union allows for
 * easy mocking in tests without requiring all internal class fields.
 */
export interface LoopBackend {
  connect: AcpBackend["connect"];
  disconnect: AcpBackend["disconnect"];
  isConnected: AcpBackend["isConnected"];
  createSession: AcpBackend["createSession"];
  sendPrompt: AcpBackend["sendPrompt"];
  sendPromptAsync: AcpBackend["sendPromptAsync"];
  abortSession: AcpBackend["abortSession"];
  subscribeToEvents: AcpBackend["subscribeToEvents"];
  replyToPermission: AcpBackend["replyToPermission"];
  replyToQuestion: AcpBackend["replyToQuestion"];
  setConfigOption: AcpBackend["setConfigOption"];
  setSessionModel: AcpBackend["setSessionModel"];
}

/**
 * Options for creating a LoopEngine.
 */
export interface LoopEngineOptions {
  /** The loop configuration and state */
  loop: Loop;
  /** The agent backend to use */
  backend: LoopBackend;
  /** Git service instance (required) */
  gitService: GitService;
  /** Event emitter instance (optional, defaults to global) */
  eventEmitter?: SimpleEventEmitter<LoopEvent>;
  /** Callback to persist state to disk (optional) */
  onPersistState?: (state: LoopState) => Promise<void>;
  /** Callback fired after a plan becomes ready (optional) */
  onPlanReady?: () => Promise<void>;
  /** Skip git branch setup (for review cycles where branch is already set up) */
  skipGitSetup?: boolean;
  /** Transient attachments for the first prompt sent by this engine */
  initialPromptAttachments?: MessageImageAttachment[];
}

/**
 * Result of running an iteration.
 */
export interface IterationResult {
  /** Whether the loop should continue */
  continue: boolean;
  /** The outcome of this iteration */
  outcome: "continue" | "complete" | "error" | "plan_ready";
  /** The full response content from the AI */
  responseContent: string;
  /** Error message if outcome is "error" */
  error?: string;
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
  currentMessageId: string | null;
  toolCalls: Map<string, { id: string; name: string; input: unknown }>;
  /** ID of the current streaming response log entry (for delta combining) */
  currentResponseLogId: string | null;
  currentResponseLogContent: string;
  /** ID of the current streaming reasoning log entry (for delta combining) */
  currentReasoningLogId: string | null;
  currentReasoningLogContent: string;
}

// Re-export loop types used by engine consumers so they don't have to reach into types/loop
export type { LoopConfig, LoopState, Loop, LoopLogEntry, ModelConfig };
