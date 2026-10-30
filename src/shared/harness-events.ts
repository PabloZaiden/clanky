/**
 * Provider-neutral execution events, separate from scheduled Clanky Agent events.
 */
import type { MessageAttachment } from "@/shared/message-attachments";
import type { HarnessActivity } from "./harness-control";

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

export interface ProviderImageFileReference {
  path: string;
  attachment: Omit<MessageAttachment, "data">;
}

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
  valueType?: "string" | "number" | "integer";
  minimum?: number;
  maximum?: number;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export type HarnessEventPayload =
  | { type: "activity.changed"; activity?: HarnessActivity }
  | { type: "user.message"; content: string; messageId?: string }
  | { type: "message.start"; messageId: string }
  | { type: "message.delta"; content: string; messageId?: string }
  | {
      type: "message.complete";
      content: string;
      messageId?: string;
      attachments?: MessageAttachment[];
      providerImageFile?: ProviderImageFileReference;
    }
  | { type: "reasoning.delta"; content: string; reasoningId?: string; complete?: boolean }
  | { type: "tool.start"; toolCallId?: string; toolName: string; input: unknown }
  | { type: "tool.complete"; toolCallId?: string; toolName: string; input?: unknown; output: unknown }
  | { type: "request.error"; message: string; code: string; details?: Readonly<Record<string, unknown>> }
  | { type: "error"; message: string; code?: string; details?: Readonly<Record<string, unknown>> }
  | { type: "permission.asked"; requestId: string; sessionId: string; permission: string; patterns: string[] }
  | { type: "question.asked"; requestId: string; sessionId: string; questions: QuestionInfo[]; blocking?: boolean; responseMode?: "callback" | "message"; secretIdentifier?: string }
  | { type: "question.resolved"; requestId: string; outcome: "answered" | "cancelled" | "expired" }
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
  timestamp?: string;
  sourceEventId?: string;
  sourceSequence?: number;
};
