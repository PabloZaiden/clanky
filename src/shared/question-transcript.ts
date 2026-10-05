/**
 * Projects newly recorded question interactions into durable conversation messages.
 */

import type { HarnessQuestionRequest } from "./harness-questions";
import { formatHarnessAnswers, formatHarnessQuestions } from "./harness-questions";
import type { PersistedMessage } from "./task";

export function projectQuestionMessages(
  messages: PersistedMessage[],
  requests: HarnessQuestionRequest[] = [],
): PersistedMessage[] {
  const existing = new Map(messages.map((message) => [message.id, message]));
  const updates: PersistedMessage[] = [];
  for (const request of requests) {
    const transcript = request.transcript;
    if (!transcript) continue;
    const question = { requestId: request.requestId, scope: request.scope, status: request.status };
    const previous = existing.get(transcript.questionMessageId);
    updates.push({
      ...previous,
      id: transcript.questionMessageId,
      role: "assistant",
      content: request.responseMode === "message" && previous
        ? previous.content
        : formatHarnessQuestions(request.questions),
      timestamp: previous?.timestamp ?? request.createdAt,
      question,
    });
    if (transcript.answerTimestamp && request.answers) {
      updates.push({
        id: transcript.answerMessageId,
        role: "user",
        content: formatHarnessAnswers(request),
        timestamp: transcript.answerTimestamp,
        question,
      });
    }
  }
  return updates.filter((message) => {
    const previous = existing.get(message.id);
    return !previous || previous.content !== message.content || previous.timestamp !== message.timestamp
      || JSON.stringify(previous.question) !== JSON.stringify(message.question);
  });
}
