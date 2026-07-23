import {
  shouldIncludeChatTranscriptLog,
  type Chat,
  type ChatState,
  type ChatTranscriptCursor,
  type ChatTranscriptStorageEntry,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";
import { rowToChat, safeJsonParse } from "./helpers";

const log = createLogger("persistence:chat-transcripts");

export interface ChatTranscriptMeta {
  revision: string;
  entryCount: number;
}

interface TranscriptRow {
  entry_id: string;
  kind: ChatTranscriptStorageEntry["kind"];
  timestamp: string;
  sequence: number;
  payload: string;
}

type StateEntry = {
  id: string;
  timestamp: string;
  kind: ChatTranscriptStorageEntry["kind"];
  payload: unknown;
};

function getEntryKey(kind: StateEntry["kind"], id: string): string {
  return `${kind}:${id}`;
}

function getStateEntries(state: ChatState): StateEntry[] {
  return [
    ...state.messages.map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      kind: "message" as const,
      payload: message,
    })),
    ...state.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      timestamp: toolCall.timestamp,
      kind: "tool" as const,
      payload: toolCall,
    })),
    ...state.logs.filter(shouldIncludeChatTranscriptLog).map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      kind: "log" as const,
      payload: log,
    })),
  ];
}

function sortStateEntries(entries: StateEntry[]): StateEntry[] {
  return [...entries].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    const byKind = left.kind.localeCompare(right.kind);
    return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
  });
}

function getRevision(entries: StateEntry[], updatedAt: string): string {
  const sorted = sortStateEntries(entries);
  return `${sorted.length}:${sorted.at(-1)?.timestamp ?? ""}:${updatedAt}`;
}

function upsertEntry(
  db: ReturnType<typeof getDatabase>,
  chatId: string,
  userId: string,
  entry: StateEntry,
  sequence: number,
  now: string,
): void {
  db.prepare(`
    INSERT INTO chat_transcript_entries (
      chat_id, user_id, entry_id, kind, timestamp, sequence, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, entry_id) DO UPDATE SET
      user_id = excluded.user_id,
      kind = excluded.kind,
      timestamp = excluded.timestamp,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(
    chatId,
    userId,
    getEntryKey(entry.kind, entry.id),
    entry.kind,
    entry.timestamp,
    sequence,
    JSON.stringify(entry.payload),
    now,
    now,
  );
}

function updateMeta(
  db: ReturnType<typeof getDatabase>,
  chatId: string,
  userId: string,
  revision: string,
  entryCount: number,
  now: string,
): void {
  db.prepare(`
    INSERT INTO chat_transcript_meta (chat_id, user_id, revision, entry_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      revision = excluded.revision,
      entry_count = excluded.entry_count,
      updated_at = excluded.updated_at
  `).run(chatId, userId, revision, entryCount, now);
}

function replaceChatTranscriptEntriesForUser(chat: Chat, userId: string): void {
  const db = getDatabase();
  const entries = sortStateEntries(getStateEntries(chat.state));
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare("DELETE FROM chat_transcript_entries WHERE chat_id = ? AND user_id = ?").run(chat.config.id, userId);
    const insert = db.prepare(`
      INSERT INTO chat_transcript_entries (
        chat_id, user_id, entry_id, kind, timestamp, sequence, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [sequence, entry] of entries.entries()) {
      insert.run(
        chat.config.id,
        userId,
        getEntryKey(entry.kind, entry.id),
        entry.kind,
        entry.timestamp,
        sequence,
        JSON.stringify(entry.payload),
        now,
        now,
      );
    }
    updateMeta(db, chat.config.id, userId, getRevision(entries, now), entries.length, now);
  })();
}

export function getChatTranscriptMeta(chatId: string): ChatTranscriptMeta | null {
  const row = getDatabase()
    .prepare(`
      SELECT revision, entry_count
      FROM chat_transcript_meta
      WHERE chat_id = ? AND user_id = ?
    `)
    .get(chatId, requirePersistenceUserId()) as {
      revision: string;
      entry_count: number;
    } | null;
  return row
    ? { revision: row.revision, entryCount: row.entry_count }
    : null;
}

export function replaceChatTranscriptEntries(chat: Chat): void {
  replaceChatTranscriptEntriesForUser(chat, requirePersistenceUserId());
}

export interface LegacyChatTranscriptMigrationResult {
  candidates: number;
  migratedChats: number;
  remainingChats: number;
}

/**
 * Backfill every chat that has not yet received normalized transcript metadata.
 *
 * Each chat is migrated in its own transaction so an interrupted startup can
 * resume without repeating completed work or leaving a partial transcript.
 */
export function migrateLegacyChatTranscripts(): LegacyChatTranscriptMigrationResult {
  const db = getDatabase();
  const candidates = db.prepare(`
    SELECT chats.id, chats.user_id
    FROM chats
    LEFT JOIN chat_transcript_meta
      ON chat_transcript_meta.chat_id = chats.id
      AND chat_transcript_meta.user_id = chats.user_id
    WHERE chat_transcript_meta.chat_id IS NULL
    ORDER BY chats.updated_at ASC, chats.id ASC
  `).all() as Array<{ id: string; user_id: string }>;

  if (candidates.length === 0) {
    return {
      candidates: 0,
      migratedChats: 0,
      remainingChats: 0,
    };
  }

  log.info("Starting legacy chat transcript backfill", {
    chatCount: candidates.length,
  });

  const loadChatRow = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?");
  let migratedChats = 0;
  for (const candidate of candidates) {
    const row = loadChatRow.get(candidate.id, candidate.user_id) as Record<string, unknown> | null;
    if (!row) {
      throw new Error(`Chat disappeared during legacy transcript backfill: ${candidate.id}`);
    }

    try {
      replaceChatTranscriptEntriesForUser(rowToChat(row), candidate.user_id);
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

  log.info("Completed legacy chat transcript backfill", {
    migratedChats,
  });
  return {
    candidates: candidates.length,
    migratedChats,
    remainingChats: remainingRow.count,
  };
}

export function syncChatTranscriptEntriesInTransaction(
  db: ReturnType<typeof getDatabase>,
  chatId: string,
  previousState: ChatState,
  nextState: ChatState,
): void {
  const userId = requirePersistenceUserId();
  const meta = getChatTranscriptMeta(chatId);
  if (!meta) {
    return;
  }

  const previousEntries = new Map(
    getStateEntries(previousState).map((entry) => [getEntryKey(entry.kind, entry.id), entry]),
  );
  const nextEntries = sortStateEntries(getStateEntries(nextState));
  const nextEntryKeys = new Set(nextEntries.map((entry) => getEntryKey(entry.kind, entry.id)));
  const maxSequenceRow = db.prepare(`
    SELECT COALESCE(MAX(sequence), -1) AS sequence
    FROM chat_transcript_entries
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as { sequence: number };
  let nextSequence = maxSequenceRow.sequence + 1;
  const now = new Date().toISOString();

  for (const entry of nextEntries) {
    const entryKey = getEntryKey(entry.kind, entry.id);
    const previous = previousEntries.get(entryKey);
    if (
      previous
      && previous.timestamp === entry.timestamp
      && previous.payload === entry.payload
    ) {
      continue;
    }
    const existingRow = db.prepare(`
      SELECT 1
      FROM chat_transcript_entries
      WHERE chat_id = ? AND user_id = ? AND entry_id = ?
    `).get(chatId, userId, entryKey);
    upsertEntry(db, chatId, userId, entry, existingRow ? 0 : nextSequence++, now);
  }

  for (const entryKey of previousEntries.keys()) {
    if (!nextEntryKeys.has(entryKey)) {
      db.prepare(`
        DELETE FROM chat_transcript_entries
        WHERE chat_id = ? AND user_id = ? AND entry_id = ?
      `).run(chatId, userId, entryKey);
    }
  }

  updateMeta(db, chatId, userId, getRevision(nextEntries, now), nextEntries.length, now);
}

export function syncChatTranscriptEntries(
  chatId: string,
  previousState: ChatState,
  nextState: ChatState,
): void {
  const db = getDatabase();
  db.transaction(() => {
    syncChatTranscriptEntriesInTransaction(db, chatId, previousState, nextState);
  })();
}

function rowToStorageEntry(row: TranscriptRow): ChatTranscriptStorageEntry {
  return {
    id: row.entry_id.startsWith(`${row.kind}:`)
      ? row.entry_id.slice(row.kind.length + 1)
      : row.entry_id,
    kind: row.kind,
    timestamp: row.timestamp,
    sequence: row.sequence,
    payload: safeJsonParse(row.payload, null, "chat_transcript_entry", row.entry_id),
  };
}

export function listChatTranscriptEntries(
  chatId: string,
  before: ChatTranscriptCursor | undefined,
  limit: number,
): ChatTranscriptStorageEntry[] {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const params: (string | number)[] = [chatId, userId];
  let beforeClause = "";
  if (before) {
    beforeClause = `
      AND (
        timestamp < ?
        OR (timestamp = ? AND kind < ?)
        OR (timestamp = ? AND kind = ? AND entry_id < ?)
      )
    `;
    params.push(
      before.timestamp,
      before.timestamp,
      before.kind,
      before.timestamp,
      before.kind,
      getEntryKey(before.kind, before.id),
    );
  }
  params.push(limit);

  const rows = db.prepare(`
    SELECT entry_id, kind, timestamp, sequence, payload
    FROM chat_transcript_entries
    WHERE chat_id = ? AND user_id = ?
    ${beforeClause}
    ORDER BY timestamp DESC, kind DESC, entry_id DESC
    LIMIT ?
  `).all(...params) as TranscriptRow[];

  return rows.map(rowToStorageEntry);
}

export function getChatToolCallFromTranscript(
  chatId: string,
  toolCallId: string,
): unknown | null {
  const row = getDatabase().prepare(`
    SELECT payload
    FROM chat_transcript_entries
    WHERE chat_id = ? AND user_id = ? AND entry_id = ?
    LIMIT 1
  `).get(chatId, requirePersistenceUserId(), getEntryKey("tool", toolCallId)) as { payload: string } | null;
  return row
    ? safeJsonParse(row.payload, null, "chat_transcript_tool_call", toolCallId)
    : null;
}
