import type { Database } from "bun:sqlite";
import type {
  Chat,
  ChatState,
  ChatTranscriptStorageEntry,
  ToolCallRecord,
} from "@/shared";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";
import { chatTranscriptStore } from "../transcripts/chat-store";
import type { TranscriptMeta } from "../transcripts/types";

export type ChatTranscriptMeta = TranscriptMeta;

export function getChatTranscriptMeta(chatId: string): ChatTranscriptMeta | null {
  return chatTranscriptStore.getMetaForUser(chatId, requirePersistenceUserId());
}

export function replaceChatTranscriptEntriesForUserInTransaction(
  db: Database,
  chat: Chat,
  userId: string,
): void {
  chatTranscriptStore.replaceForUserInTransaction(
    db,
    chat.config.id,
    userId,
    chat.state,
  );
}
export function replaceChatTranscriptEntriesForUser(chat: Chat, userId: string): void {
  chatTranscriptStore.replaceForUser(
    chat.config.id,
    userId,
    chat.state,
  );
}

export function replaceChatTranscriptEntries(chat: Chat): void {
  replaceChatTranscriptEntriesForUser(chat, requirePersistenceUserId());
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
    requirePersistenceUserId(),
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
    requirePersistenceUserId(),
    includeToolPayload,
  );
}

export function listChatTranscriptEntriesPage(
  chatId: string,
  options: { full?: boolean; before?: string } = {},
) {
  return chatTranscriptStore.listPage(chatId, options);
}

export function getChatToolCallFromTranscript(
  chatId: string,
  toolCallId: string,
): ToolCallRecord | null {
  return chatTranscriptStore.getToolCallForUser(
    chatId,
    requirePersistenceUserId(),
    toolCallId,
  );
}
