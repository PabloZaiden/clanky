/**
 * Provider-neutral execution events, separate from scheduled Clanky Agent events.
 */

export const HARNESS_ADAPTER_IDS = ["acp", "copilot", "codex", "opencode2"] as const;
export type HarnessAdapter = typeof HARNESS_ADAPTER_IDS[number];

export interface HarnessNativeReferences {
  adapter: HarnessAdapter;
  conversationId?: string;
  turnId?: string;
  messageId?: string;
  activityId?: string;
  toolCallId?: string;
  commandId?: string;
}

export type HarnessEventScope =
  | { kind: "principal"; native?: HarnessNativeReferences }
  | { kind: "child"; activityId: string; native?: HarnessNativeReferences }
  | { kind: "unknown"; native?: HarnessNativeReferences };

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export type HarnessEventPayload =
  | { type: "activity.changed" }
  | { type: "user.message"; content: string }
  | { type: "message.start"; messageId: string }
  | { type: "message.delta"; content: string }
  | { type: "message.complete"; content: string }
  | { type: "reasoning.delta"; content: string }
  | { type: "tool.start"; toolCallId?: string; toolName: string; input: unknown }
  | { type: "tool.complete"; toolCallId?: string; toolName: string; input?: unknown; output: unknown }
  | { type: "request.error"; message: string; code: string; details?: Readonly<Record<string, unknown>> }
  | { type: "error"; message: string; code?: string; details?: Readonly<Record<string, unknown>> }
  | { type: "permission.asked"; requestId: string; sessionId: string; permission: string; patterns: string[] }
  | { type: "question.asked"; requestId: string; sessionId: string; questions: QuestionInfo[] }
  | { type: "prompt.complete"; outcome: "completed" | "interrupted" }
  | {
      type: "session.status";
      sessionId: string;
      status: "idle" | "busy" | "retry";
      attempt?: number;
      message?: string;
      stopReason?: string;
    };

/** Message completion and prompt completion do not imply descendant cleanup. */
export type HarnessEvent = HarnessEventPayload & {
  scope: HarnessEventScope;
  sourceEventId?: string;
  sourceSequence?: number;
};
