/**
 * Durable user-input requests; native callbacks remain owned by the adapter.
 */

import type { HarnessConversationBinding, HarnessConversationState } from "./harness-control";
import type { HarnessEventScope, QuestionInfo } from "./harness-events";

export interface HarnessQuestionRequest {
  requestId: string;
  conversation: HarnessConversationBinding;
  scope: HarnessEventScope;
  questions: QuestionInfo[];
  blocking: boolean;
  responseMode?: "callback" | "message";
  status: "pending" | "queued" | "submitting" | "unconfirmed" | "answered" | "cancelled" | "expired";
  createdAt: string;
  resolvedAt?: string;
  answers?: string[][];
  error?: string;
  transcript?: {
    questionMessageId: string;
    answerMessageId: string;
    answerTimestamp?: string;
  };
}

export interface QuestionMessageData {
  requestId: string;
  scope: HarnessEventScope;
  status: HarnessQuestionRequest["status"];
}

export function formatHarnessQuestions(questions: QuestionInfo[], context?: string): string {
  const content = questions.map((question, index) => questions.length === 1
    ? question.question
    : `${index + 1}. ${question.question}`).join("\n\n");
  return context && context !== content ? `${context}\n\n${content}` : content;
}

export function formatHarnessAnswers(request: HarnessQuestionRequest): string {
  return request.questions.map((question, index) => {
    const answer = request.answers?.[index]?.join(", ") || "(No answer provided)";
    return request.questions.length === 1 ? answer : `${index + 1}. ${question.question}\n${answer}`;
  }).join("\n\n");
}

export function getQuestionAnswerStatus(status: HarnessQuestionRequest["status"]): string | undefined {
  if (status === "answered") return undefined;
  if (status === "queued") return "Answer queued";
  if (status === "submitting") return "Sending answer";
  if (status === "pending") return "Answer not sent";
  return "Delivery unconfirmed";
}

export function isQuestionOpen(request: HarnessQuestionRequest): boolean {
  return request.status === "pending" || request.status === "queued" || request.status === "submitting" || request.status === "unconfirmed";
}

export function updateQuestionAnswerStatus(
  harness: HarnessConversationState | undefined,
  inputId: string,
  status: HarnessQuestionRequest["status"],
): HarnessConversationState | undefined {
  let changed = false;
  const questions = harness?.questions?.map((request) => {
    if (request.responseMode !== "message" || request.transcript?.answerMessageId !== inputId
      || !request.transcript.answerTimestamp || request.status === status) return request;
    if ((request.status === "cancelled" || request.status === "expired") && status !== "answered") return request;
    changed = true;
    return {
      ...request, status, error: undefined,
      resolvedAt: status === "answered" ? new Date().toISOString() : undefined,
    };
  });
  return changed ? { ...harness, questions } : harness;
}

export function reconcileQuestionAnswerAdmissions(
  harness: HarnessConversationState | undefined,
  queuedInputIds: readonly string[],
): HarnessConversationState | undefined {
  let updated = harness;
  for (const { admission } of harness?.inputs ?? []) {
    updated = updateQuestionAnswerStatus(updated, admission.inputId,
      admission.status === "delivered" ? "answered"
        : admission.status === "rejected" ? queuedInputIds.includes(admission.inputId) ? "queued" : "pending"
          : "unconfirmed");
  }
  return updated;
}

export function closeOpenQuestions(
  requests: HarnessQuestionRequest[] | undefined,
  outcome: "cancelled" | "expired",
): HarnessQuestionRequest[] | undefined {
  // Enqueued replies are independent conversation inputs; interruption does
  // not confirm or discard them before the queue dispatches or removes them.
  return requests?.map((request) => isQuestionOpen(request) && request.status !== "queued"
    ? { ...request, status: outcome, resolvedAt: new Date().toISOString() }
    : request);
}
