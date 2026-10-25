/**
 * Resolves chat ownership/history before delegating execution-host file copies.
 */

import type { Chat, PersistedMessage } from "@/shared";
import type { MessageAttachment } from "@/shared/message-attachments";
import { DomainError } from "../domain/domain-error";
import { isPersistedMessage } from "../persistence/transcripts/codec";
import { getChatExecutionHostBinding } from "./chat-history-export-service";
import type { ChatStatePort } from "./chat-service-contracts";
import { conversationAttachmentService } from "./conversation-attachment-service";
import type { QuestionMessageData } from "@/shared/harness-questions";

export class ChatAttachmentService {
  constructor(private readonly state: Pick<ChatStatePort, "getWorkspace" | "iterateChatTranscriptEntries">) {}

  async prepare(chat: Chat, message: { id: string; attachments?: readonly MessageAttachment[]; question?: QuestionMessageData }, options: {
    credentialToken?: string | null;
    signal?: AbortSignal;
  } = {}) {
    const directory = chat.state.session?.binding?.directory
      ?? chat.state.worktree?.worktreePath
      ?? chat.config.directory;
    return await conversationAttachmentService.materialize({
      context: { kind: "chat", id: chat.config.id },
      executionHost: await getChatExecutionHostBinding(this.state, chat),
      directory,
      message,
      previousMessages: this.history(chat.config.id),
      ...options,
    });
  }

  private async *history(chatId: string): AsyncIterable<PersistedMessage> {
    for await (const entry of this.state.iterateChatTranscriptEntries(chatId, { fileAttachmentsOnly: true })) {
      if (entry.kind !== "message") continue;
      if (!isPersistedMessage(entry.payload)) {
        throw new DomainError("attachment_data_invalid", "A saved message's attachments could not be restored.");
      }
      yield entry.payload;
    }
  }
}
