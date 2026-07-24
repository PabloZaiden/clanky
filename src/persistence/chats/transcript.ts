import type { Database } from "bun:sqlite";
import type {
  Chat,
  ChatState,
  ChatTranscriptCursor,
  ChatTranscriptStorageEntry,
  ToolCallRecord,
} from "@/shared";
import { mergeToolCallRecords } from "@/shared/tool-call";
import { shouldIncludeChatTranscriptLog } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";
import { rowToChat } from "./helpers";
import {
  countTranscriptEntriesForUser,
  getTranscriptMetaForUser,
  getTranscriptToolCallForUser,
  hasLegacyTranscriptColumns,
  hydrateTranscriptStateForUser,
  listTranscriptEntriesForUser,
  replaceTranscriptEntriesForUser,
  syncTranscriptEntriesInTransaction,
  type TranscriptMeta,
} from "../transcripts/store";

const log = createLogger("persistence:chat-transcripts");

export type ChatTranscriptMeta = TranscriptMeta;

export function getChatTranscriptMeta(chatId: string): ChatTranscriptMeta | null {
  return getTranscriptMetaForUser("chat", chatId, requirePersistenceUserId());
}

export function countChatTranscriptEntries(chatId: string): number {
  return countTranscriptEntriesForUser(
    "chat",
    chatId,
    requirePersistenceUserId(),
    shouldIncludeChatTranscriptLog,
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

export interface LegacyChatTranscriptMigrationResult {
  candidates: number;
  migratedChats: number;
  remainingChats: number;
}

function hasLegacyTranscriptPayload(row: Record<string, unknown>): boolean {
  return ["messages", "logs", "tool_calls"].some((column) => {
    const value = row[column];
    if (typeof value !== "string") {
      return false;
    }
    const normalized = value.trim();
    return normalized.length > 0 && normalized !== "[]" && normalized !== "null";
  });
}

function assertLegacyTranscriptPayloadIsReadable(
  row: Record<string, unknown>,
  chatId: string,
): void {
  for (const column of ["messages", "logs", "tool_calls"]) {
    const value = row[column];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error("expected an array");
      }
    } catch (error) {
      throw new Error(`Invalid legacy chat transcript field ${column} for ${chatId}`, { cause: error });
    }
  }
}

function mergeRecordsById<T extends { id: string }>(current: T[], legacy: T[]): T[] {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of legacy) {
    records.set(record.id, record);
  }
  return Array.from(records.values());
}

function mergeLegacyTranscriptState(
  chat: Chat,
  normalizedState: ReturnType<typeof hydrateTranscriptStateForUser>,
): Chat {
  return {
    ...chat,
    state: {
      ...chat.state,
      messages: mergeRecordsById(normalizedState.messages, chat.state.messages),
      logs: mergeRecordsById(normalizedState.logs, chat.state.logs),
      toolCalls: mergeToolCallRecords(normalizedState.toolCalls, chat.state.toolCalls),
    },
  };
}

/**
 * Backfill every chat while legacy transcript columns still exist. This also
 * repairs chats normalized by the previous migration, whose filtered log set
 * may not contain every legacy log before those columns are removed.
 */
export function migrateLegacyChatTranscripts(): LegacyChatTranscriptMigrationResult {
  const db = getDatabase();
  if (!hasLegacyTranscriptColumns("chat")) {
    return { candidates: 0, migratedChats: 0, remainingChats: 0 };
  }
  const candidates = db.prepare(`
    SELECT chats.id, chats.user_id,
      CASE WHEN chat_transcript_meta.chat_id IS NULL THEN 0 ELSE 1 END AS has_metadata
    FROM chats
    LEFT JOIN chat_transcript_meta
      ON chat_transcript_meta.chat_id = chats.id
      AND chat_transcript_meta.user_id = chats.user_id
    ORDER BY chats.updated_at ASC, chats.id ASC
  `).all() as Array<{ id: string; user_id: string; has_metadata: number }>;

  if (candidates.length === 0) {
    return { candidates: 0, migratedChats: 0, remainingChats: 0 };
  }

  log.info("Starting legacy chat transcript backfill", {
    chatCount: candidates.length,
  });

  const loadChatRow = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?");
  const clearLegacyTranscript = db.prepare(`
    UPDATE chats
    SET messages = NULL, logs = NULL, tool_calls = NULL
    WHERE id = ? AND user_id = ?
  `);
  let migratedChats = 0;
  for (const candidate of candidates) {
    const row = loadChatRow.get(candidate.id, candidate.user_id) as Record<string, unknown> | null;
    if (!row) {
      throw new Error(`Chat disappeared during legacy transcript backfill: ${candidate.id}`);
    }

    try {
      const hasMetadata = candidate.has_metadata === 1;
      const hasLegacyPayload = hasLegacyTranscriptPayload(row);
      if (hasMetadata && !hasLegacyPayload) {
        clearLegacyTranscript.run(candidate.id, candidate.user_id);
        migratedChats += 1;
        continue;
      }

      if (hasLegacyPayload) {
        assertLegacyTranscriptPayloadIsReadable(row, candidate.id);
      }
      const legacyChat = rowToChat(row);
      const chat = hasMetadata
        ? mergeLegacyTranscriptState(
            legacyChat,
            hydrateTranscriptStateForUser("chat", candidate.id, candidate.user_id),
          )
        : legacyChat;
      replaceChatTranscriptEntriesForUser(chat, candidate.user_id);
      clearLegacyTranscript.run(candidate.id, candidate.user_id);
    } catch (error) {
      log.error("Failed to backfill legacy chat transcript", {
        chatId: candidate.id,
        error: String(error),
      });
      throw new Error(`Failed to migrate legacy chat transcript ${candidate.id}`, { cause: error });
    }
    migratedChats += 1;
  }

  const remainingRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM chats
    LEFT JOIN chat_transcript_meta
      ON chat_transcript_meta.chat_id = chats.id
      AND chat_transcript_meta.user_id = chats.user_id
    WHERE chat_transcript_meta.chat_id IS NULL
  `).get() as { count: number };
  if (remainingRow.count > 0) {
    throw new Error(`Legacy chat transcript backfill incomplete: ${remainingRow.count} chats remain`);
  }

  log.info("Completed legacy chat transcript backfill", { migratedChats });
  return {
    candidates: candidates.length,
    migratedChats,
    remainingChats: remainingRow.count,
  };
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
  before: ChatTranscriptCursor | undefined,
  limit: number,
): ChatTranscriptStorageEntry[] {
  return listTranscriptEntriesForUser(
    "chat",
    chatId,
    requirePersistenceUserId(),
    before,
    limit,
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
