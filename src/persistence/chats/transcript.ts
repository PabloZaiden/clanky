import type { Database } from "bun:sqlite";
import type {
  Chat,
  ChatState,
  ChatTranscriptStorageEntry,
  PersistedMessage,
  ToolCallRecord,
} from "@/shared";
import type { TranscriptStorageCursor, TranscriptStoragePage } from "../transcripts/types";
import { getDatabase } from "../database";
import { assertResourcePersistenceUser, requireResourcePersistenceUserId } from "../ownership";
import { chatTranscriptStore } from "../transcripts/chat-store";
import type { TranscriptMeta } from "../transcripts/types";

export type ChatTranscriptMeta = TranscriptMeta;

export function getChatTranscriptMeta(chatId: string): ChatTranscriptMeta | null {
  return chatTranscriptStore.getMetaForUser(chatId, requireResourcePersistenceUserId("chat", chatId));
}

export function hasSingleChatUserMessage(chatId: string): boolean {
  return getDatabase().prepare(`
    SELECT 1
    FROM chat_transcript_entries
    WHERE user_id = ? AND chat_id = ? AND kind = 'message' AND message_role = 'user'
    LIMIT 2
  `).all(requireResourcePersistenceUserId("chat", chatId), chatId).length === 1;
}

export function replaceChatTranscriptEntriesForUserInTransaction(
  db: Database,
  chat: Chat,
  userId: string,
): void {
  assertResourcePersistenceUser("chat", chat.config.id, userId);
  chatTranscriptStore.replaceForUserInTransaction(
    db,
    chat.config.id,
    userId,
    chat.state,
  );
}
export function replaceChatTranscriptEntriesForUser(chat: Chat, userId: string): void {
  assertResourcePersistenceUser("chat", chat.config.id, userId);
  chatTranscriptStore.replaceForUser(
    chat.config.id,
    userId,
    chat.state,
  );
}

export function replaceChatTranscriptEntries(chat: Chat): void {
  replaceChatTranscriptEntriesForUser(chat, requireResourcePersistenceUserId("chat", chat.config.id));
}

export function syncChatTranscriptEntriesInTransaction(
  db: Database,
  chatId: string,
  previousState: ChatState,
  nextState: ChatState,
): void {
  chatTranscriptStore.syncInTransaction(
    db,
    chatId,
    requireResourcePersistenceUserId("chat", chatId),
    previousState,
    nextState,
  );
}

export function syncChatTranscriptEntries(
  chatId: string,
  previousState: ChatState,
  nextState: ChatState,
): void {
  const db = getDatabase();
  syncChatTranscriptEntriesInTransaction(db, chatId, previousState, nextState);
}

export function listChatTranscriptEntries(
  chatId: string,
  includeToolPayload = false,
): ChatTranscriptStorageEntry[] {
  return chatTranscriptStore.listForUser(
    chatId,
    requireResourcePersistenceUserId("chat", chatId),
    includeToolPayload,
  );
}

export function listChatTranscriptEntriesPage(
  chatId: string,
  options: { full?: boolean; before?: string } = {},
) {
  return chatTranscriptStore.listPage(chatId, options);
}

export function listChatTranscriptEntriesAfter(
  chatId: string,
  options: {
    after?: TranscriptStorageCursor;
    limit: number;
    includeToolPayload?: boolean;
    fileAttachmentsOnly?: boolean;
  },
): TranscriptStoragePage {
  return chatTranscriptStore.listEntriesAfterForUser(
    chatId,
    requireResourcePersistenceUserId("chat", chatId),
    options,
  );
}

export function getChatToolCallFromTranscript(
  chatId: string,
  toolCallId: string,
): ToolCallRecord | null {
  return chatTranscriptStore.getToolCallForUser(
    chatId,
    requireResourcePersistenceUserId("chat", chatId),
    toolCallId,
  );
}

export function getChatMessageFromTranscript(
  chatId: string,
  messageId: string,
): PersistedMessage | null {
  return chatTranscriptStore.getMessageForUser(
    chatId,
    requireResourcePersistenceUserId("chat", chatId),
    messageId,
  );
}
