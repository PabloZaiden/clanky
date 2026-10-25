/**
 * Restores answer originals before projecting metadata-only question updates.
 */

import type { PersistedMessage } from "@/shared/task";
import type { HarnessQuestionRequest } from "@/shared/harness-questions";
import { projectQuestionMessages } from "@/shared/question-transcript";
import { HarnessError } from "../backends/harness-errors";

export async function projectChatQuestionMessages({ messages, requests = [], getMessage }: {
  messages: PersistedMessage[];
  requests?: HarnessQuestionRequest[];
  getMessage: (id: string) => Promise<PersistedMessage | null>;
}): Promise<PersistedMessage[]> {
  const existing = new Map(messages.map((message) => [message.id, message]));
  const restored = new Map<string, PersistedMessage>();
  for (const request of requests) {
    const id = request.transcript?.answerMessageId;
    const imageIds = request.attachmentIds?.flat() ?? [];
    if (!id || !imageIds.length) continue;
    const matches = (message: PersistedMessage | null | undefined): boolean =>
      JSON.stringify(message?.attachments?.map((image) => image.id)) === JSON.stringify(imageIds);
    if (matches(existing.get(id))) continue;
    const message = await getMessage(id);
    if (!message || !matches(message)) {
      throw new HarnessError("harness_question_invalid", "The saved answer images could not be restored.");
    }
    existing.set(id, message);
    restored.set(id, message);
  }
  for (const message of projectQuestionMessages([...existing.values()], requests)) {
    restored.set(message.id, message);
  }
  return [...restored.values()];
}
