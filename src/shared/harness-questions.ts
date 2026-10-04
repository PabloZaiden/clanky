/**
 * Durable user-input requests; native callbacks remain owned by the adapter.
 */

import type { HarnessConversationBinding } from "./harness-control";
import type { HarnessEventScope, QuestionInfo } from "./harness-events";

export interface HarnessQuestionRequest {
  requestId: string;
  conversation: HarnessConversationBinding;
  scope: HarnessEventScope;
  questions: QuestionInfo[];
  blocking: boolean;
  responseMode?: "callback" | "message";
  status: "pending" | "submitting" | "unconfirmed" | "answered" | "cancelled" | "expired";
  createdAt: string;
  resolvedAt?: string;
  answers?: string[][];
  error?: string;
}

export function isQuestionOpen(request: HarnessQuestionRequest): boolean {
  return request.status === "pending" || request.status === "submitting" || request.status === "unconfirmed";
}

export function expireQuestions(requests: HarnessQuestionRequest[] | undefined): HarnessQuestionRequest[] | undefined {
  return requests?.map((request) => isQuestionOpen(request)
    ? { ...request, status: "expired", resolvedAt: new Date().toISOString() }
    : request);
}
