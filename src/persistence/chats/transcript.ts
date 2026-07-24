import type { Database } from "bun:sqlite";
import type {
  Chat,
  ChatState,
  ChatTranscriptStorageEntry,
  ToolCallRecord,
} from "@/shared";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";
import {
  getTranscriptMetaForUser,
  getTranscriptToolCallForUser,
  listTranscriptEntriesForUser,
  replaceTranscriptEntriesForUser,
  replaceTranscriptEntriesForUserInTransaction,
  syncTranscriptEntriesInTransaction,
  type TranscriptMeta,
} from "../transcripts/store";

export type ChatTranscriptMeta = TranscriptMeta;

export function getChatTranscriptMeta(chatId: string): ChatTranscriptMeta | null {
  return getTranscriptMetaForUser("chat", chatId, requirePersistenceUserId());
}

export function replaceChatTranscriptEntriesForUserInTransaction(
  db: Database,
  chat: Chat,
  userId: string,
): void {
  replaceTranscriptEntriesForUserInTransaction(
    db,
    "chat",
    chat.config.id,
    userId,
    chat.state,
  );
}

export function replaceChatTranscriptEntriesForUser(chat: Chat, userId: string): void {
  replaceTranscriptEntriesForUser(
    "chat",
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
  syncTranscriptEntriesInTransaction(
    db,
    "chat",
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
  return listTranscriptEntriesForUser(
    "chat",
    chatId,
    requirePersistenceUserId(),
    includeToolPayload,
  );
}

export function getChatToolCallFromTranscript(
  chatId: string,
  toolCallId: string,
): ToolCallRecord | null {
  return getTranscriptToolCallForUser(
    "chat",
    chatId,
    requirePersistenceUserId(),
    toolCallId,
  );
}
