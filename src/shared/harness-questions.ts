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
  if (status === "submitting") return "Sending answer";
  if (status === "pending") return "Answer not sent";
  return "Delivery unconfirmed";
}

export function isQuestionOpen(request: HarnessQuestionRequest): boolean {
  return request.status === "pending" || request.status === "submitting" || request.status === "unconfirmed";
}

export function closeOpenQuestions(
  requests: HarnessQuestionRequest[] | undefined,
  outcome: "cancelled" | "expired",
): HarnessQuestionRequest[] | undefined {
  return requests?.map((request) => isQuestionOpen(request)
    ? { ...request, status: outcome, resolvedAt: new Date().toISOString() }
    : request);
}
