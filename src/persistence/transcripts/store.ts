import type { Database } from "bun:sqlite";
import type {
  ChatTranscriptStorageEntry,
  TranscriptChangeSet,
  TranscriptEntryKind as SharedTranscriptEntryKind,
  PersistedMessage,
  TaskLogEntry,
  ToolCallRecord,
} from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:transcripts");

export type TranscriptResource = "chat" | "task" | "agent_run";
export type TranscriptEntryKind = SharedTranscriptEntryKind;

interface TranscriptTableConfig {
  parentTable: "chats" | "tasks" | "agent_runs";
  entriesTable: string;
  metaTable: string;
  resourceColumn: string;
}

const TRANSCRIPT_TABLES: Record<TranscriptResource, TranscriptTableConfig> = {
  chat: {
    parentTable: "chats",
    entriesTable: "chat_transcript_entries",
    metaTable: "chat_transcript_meta",
    resourceColumn: "chat_id",
  },
  task: {
    parentTable: "tasks",
    entriesTable: "task_transcript_entries",
    metaTable: "task_transcript_meta",
    resourceColumn: "task_id",
  },
  agent_run: {
    parentTable: "agent_runs",
    entriesTable: "agent_run_transcript_entries",
    metaTable: "agent_run_transcript_meta",
    resourceColumn: "agent_run_id",
  },
};

export interface TranscriptStateLike {
  messages: PersistedMessage[];
  logs: TaskLogEntry[];
  toolCalls: ToolCallRecord[];
}

export interface TranscriptStateEntry {
  id: string;
  timestamp: string;
  kind: TranscriptEntryKind;
  order: number;
  payload: PersistedMessage | TaskLogEntry | ToolCallRecord;
}

export interface TranscriptMeta {
  revision: string;
  entryCount: number;
}

interface TranscriptRow {
  entry_id: string;
  kind: TranscriptEntryKind;
  timestamp: string;
  sequence: number;
  payload: string;
  updated_at: string;
  tool_name: string | null;
  tool_status: ToolCallRecord["status"] | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_extras: string | null;
  tool_has_output?: number | null;
}

let nextLiveTranscriptSequence = Math.floor(Date.now() * 1000);

function getTableConfig(resource: TranscriptResource): TranscriptTableConfig {
  return TRANSCRIPT_TABLES[resource];
}

function getEntryKey(kind: TranscriptEntryKind, id: string): string {
  return `${kind}:${id}`;
}

function allocateLiveTranscriptSequence(): number {
  nextLiveTranscriptSequence += 1;
  return nextLiveTranscriptSequence;
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

function parseJson<T>(value: string | null, fallback: T, fieldName: string, rowId: string): T {
  if (value === null) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    log.warn("Failed to parse transcript JSON", {
      fieldName,
      rowId,
      error: String(error),
    });
    return fallback;
  }
}

function sortStateEntries(entries: TranscriptStateEntry[]): TranscriptStateEntry[] {
  return [...entries].sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    const byOrder = left.order - right.order;
    if (byOrder !== 0) {
      return byOrder;
    }
    const byKind = left.kind.localeCompare(right.kind);
    return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
  });
}

export function getTranscriptStateEntries(
  state: TranscriptStateLike,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): TranscriptStateEntry[] {
  let order = 0;
  return [
    ...state.messages.map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      kind: "message" as const,
      order: order++,
      payload: message,
    })),
    ...state.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      timestamp: toolCall.timestamp,
      kind: "tool" as const,
      order: order++,
      payload: toolCall,
    })),
    ...state.logs.filter(shouldIncludeLog).map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      kind: "log" as const,
      order: order++,
      payload: entry,
    })),
  ];
}

function getRevision(entries: TranscriptStateEntry[], updatedAt: string): string {
  const sorted = sortStateEntries(entries);
  return `${sorted.length}:${sorted.at(-1)?.timestamp ?? ""}:${updatedAt}`;
}

function getToolPayload(entry: Pick<TranscriptStateEntry, "kind" | "payload">): ToolCallRecord | null {
  return entry.kind === "tool" ? entry.payload as ToolCallRecord : null;
}

function upsertEntry(
  db: Database,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  entry: Pick<TranscriptStateEntry, "id" | "kind" | "timestamp" | "payload">,
  sequence: number,
  now: string,
): void {
  const config = getTableConfig(resource);
  const tool = getToolPayload(entry);
  const payload = tool ? {} : entry.payload;
  const input = tool?.input === undefined ? null : serializeJson(tool.input);
  const output = tool?.output === undefined ? null : serializeJson(tool.output);
  const extras = tool?.extras === undefined ? null : serializeJson(tool.extras);

  db.prepare(`
    INSERT INTO ${config.entriesTable} (
      ${config.resourceColumn}, user_id, entry_id, kind, timestamp, sequence,
      payload, tool_name, tool_status, tool_input, tool_output, tool_extras,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(${config.resourceColumn}, entry_id) DO UPDATE SET
      user_id = excluded.user_id,
      kind = excluded.kind,
      timestamp = excluded.timestamp,
      sequence = excluded.sequence,
      payload = excluded.payload,
      tool_name = excluded.tool_name,
      tool_status = excluded.tool_status,
      tool_input = excluded.tool_input,
      tool_output = excluded.tool_output,
      tool_extras = excluded.tool_extras,
      updated_at = excluded.updated_at
  `).run(
    resourceId,
    userId,
    getEntryKey(entry.kind, entry.id),
    entry.kind,
    entry.timestamp,
    sequence,
    serializeJson(payload),
    tool?.name ?? null,
    tool?.status ?? null,
    input,
    output,
    extras,
    now,
    now,
  );
}

function updateMeta(
  db: Database,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  revision: string,
  entryCount: number,
  now: string,
): void {
  const config = getTableConfig(resource);
  db.prepare(`
    INSERT INTO ${config.metaTable} (${config.resourceColumn}, user_id, revision, entry_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(${config.resourceColumn}) DO UPDATE SET
      user_id = excluded.user_id,
      revision = excluded.revision,
      entry_count = excluded.entry_count,
      updated_at = excluded.updated_at
  `).run(resourceId, userId, revision, entryCount, now);
}

export function replaceTranscriptEntriesForUserInTransaction(
  db: Database,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  state: TranscriptStateLike,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): void {
  const config = getTableConfig(resource);
  const entries = sortStateEntries(getTranscriptStateEntries(state, shouldIncludeLog));
  const now = new Date().toISOString();

  db.prepare(`DELETE FROM ${config.entriesTable} WHERE ${config.resourceColumn} = ? AND user_id = ?`)
    .run(resourceId, userId);
  for (const [sequence, entry] of entries.entries()) {
    upsertEntry(db, resource, resourceId, userId, entry, sequence, now);
  }
  updateMeta(db, resource, resourceId, userId, getRevision(entries, now), entries.length, now);
}

export function replaceTranscriptEntriesForUser(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  state: TranscriptStateLike,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): void {
  const db = getDatabase();
  db.transaction(() => {
    replaceTranscriptEntriesForUserInTransaction(
      db,
      resource,
      resourceId,
      userId,
      state,
      shouldIncludeLog,
    );
  })();
}

export function replaceTranscriptEntries(
  resource: TranscriptResource,
  resourceId: string,
  state: TranscriptStateLike,
  shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
): void {
  replaceTranscriptEntriesForUser(
    resource,
    resourceId,
    requirePersistenceUserId(),
    state,
    shouldIncludeLog,
  );
}

export function syncTranscriptEntriesInTransaction(
  db: Database,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  previousState: TranscriptStateLike,
  nextState: TranscriptStateLike,
  shouldIncludeLog: (entry: TaskLogEntry) => boolean = () => true,
): void {
  const config = getTableConfig(resource);
  const previousEntries = new Map(
    getTranscriptStateEntries(previousState, shouldIncludeLog)
      .map((entry) => [getEntryKey(entry.kind, entry.id), entry]),
  );
  const nextEntries = sortStateEntries(getTranscriptStateEntries(nextState, shouldIncludeLog));
  const nextEntryKeys = new Set(nextEntries.map((entry) => getEntryKey(entry.kind, entry.id)));
  const existingSequenceRows = db.prepare(`
    SELECT entry_id, sequence
    FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ?
  `).all(resourceId, userId) as Array<{ entry_id: string; sequence: number }>;
  const existingSequences = new Map(
    existingSequenceRows.map((row) => [row.entry_id, row.sequence]),
  );
  const existingMeta = db.prepare(`
    SELECT revision
    FROM ${config.metaTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ?
  `).get(resourceId, userId) as { revision: string } | null;
  let transcriptChanged = existingMeta === null;
  const maxSequenceRow = db.prepare(`
    SELECT COALESCE(MAX(sequence), -1) AS sequence
    FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ?
  `).get(resourceId, userId) as { sequence: number };
  let nextSequence = maxSequenceRow.sequence + 1;
  const now = new Date().toISOString();

  for (const entry of nextEntries) {
    const entryKey = getEntryKey(entry.kind, entry.id);
    const previous = previousEntries.get(entryKey);
    if (
      previous
      && existingSequences.has(entryKey)
      && previous.timestamp === entry.timestamp
      && serializeJson(previous.payload) === serializeJson(entry.payload)
    ) {
      continue;
    }

    const sequence = existingSequences.get(entryKey) ?? nextSequence++;
    upsertEntry(db, resource, resourceId, userId, entry, sequence, now);
    transcriptChanged = true;
  }

  for (const entryKey of existingSequences.keys()) {
    if (!nextEntryKeys.has(entryKey)) {
      db.prepare(`
        DELETE FROM ${config.entriesTable}
        WHERE ${config.resourceColumn} = ? AND user_id = ? AND entry_id = ?
      `).run(resourceId, userId, entryKey);
      transcriptChanged = true;
    }
  }

  if (transcriptChanged) {
    updateMeta(db, resource, resourceId, userId, getRevision(nextEntries, now), nextEntries.length, now);
  }
}

/**
 * Apply only the entries changed by an active stream.
 *
 * This path intentionally does not hydrate the transcript, enumerate existing
 * rows, calculate MAX(sequence), or serialize unchanged payloads. Each
 * resource owner supplies the current entry count from its in-memory state.
 */
export function applyTranscriptChangeSetInTransaction(
  db: Database,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  changes: TranscriptChangeSet,
): void {
  if (changes.upserts.length === 0 && changes.deletes.length === 0) {
    if (changes.revision !== undefined) {
      const now = new Date().toISOString();
      updateMeta(
        db,
        resource,
        resourceId,
        userId,
        changes.revision,
        changes.entryCount,
        now,
      );
    }
    return;
  }

  const config = getTableConfig(resource);
  const now = new Date().toISOString();
  const existingSequenceStmt = db.prepare(`
    SELECT sequence
    FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ? AND entry_id = ?
    LIMIT 1
  `);
  const deleteStmt = db.prepare(`
    DELETE FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ? AND entry_id = ?
  `);

  for (const entry of changes.deletes) {
    deleteStmt.run(resourceId, userId, getEntryKey(entry.kind, entry.id));
  }

  for (const entry of changes.upserts) {
    const entryKey = getEntryKey(entry.kind, entry.id);
    const existing = entry.sequence === undefined
      ? existingSequenceStmt.get(resourceId, userId, entryKey) as { sequence: number } | null
      : null;
    upsertEntry(
      db,
      resource,
      resourceId,
      userId,
      entry,
      entry.sequence ?? existing?.sequence ?? allocateLiveTranscriptSequence(),
      now,
    );
  }

  updateMeta(
    db,
    resource,
    resourceId,
    userId,
    changes.revision ?? `${now}:${changes.entryCount}:${crypto.randomUUID()}`,
    changes.entryCount,
    now,
  );
}

export function syncTranscriptEntries(
  resource: TranscriptResource,
  resourceId: string,
  previousState: TranscriptStateLike,
  nextState: TranscriptStateLike,
  shouldIncludeLog?: (entry: TaskLogEntry) => boolean,
): void {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  db.transaction(() => {
    syncTranscriptEntriesInTransaction(
      db,
      resource,
      resourceId,
      userId,
      previousState,
      nextState,
      shouldIncludeLog,
    );
  })();
}

function rowToStorageEntry(
  row: TranscriptRow,
  includeToolPayload: boolean,
  resource: TranscriptResource,
): ChatTranscriptStorageEntry {
  const idPrefix = `${row.kind}:`;
  const id = row.entry_id.startsWith(idPrefix)
    ? row.entry_id.slice(idPrefix.length)
    : row.entry_id;

  if (row.kind !== "tool") {
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: parseJson(row.payload, null, `${resource}_transcript_entry`, row.entry_id),
    };
  }

  if (row.tool_name !== null && row.tool_status !== null) {
    const tool: ToolCallRecord = {
      id,
      name: row.tool_name,
      status: row.tool_status,
      timestamp: row.timestamp,
      detailRevision: row.updated_at,
      ...(row.tool_input !== null
        ? { input: parseJson(row.tool_input, undefined, `${resource}_transcript_tool_input`, row.entry_id) }
        : {}),
      ...(includeToolPayload && row.tool_output !== null
        ? { output: parseJson(row.tool_output, undefined, `${resource}_transcript_tool_output`, row.entry_id) }
        : {}),
      ...(includeToolPayload && row.tool_extras !== null
        ? { extras: parseJson(row.tool_extras, [], `${resource}_transcript_tool_extras`, row.entry_id) }
        : {}),
    };
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: includeToolPayload ? tool : {},
      tool,
      ...(row.tool_has_output !== undefined && row.tool_has_output !== null
        ? { toolHasOutput: row.tool_has_output === 1 }
        : {}),
    };
  }

  const legacyTool = parseJson<ToolCallRecord | null>(
    row.payload,
    null,
    `${resource}_transcript_tool_call`,
    row.entry_id,
  );
  if (legacyTool && !includeToolPayload) {
    const { output: _output, extras: _extras, ...summary } = legacyTool;
    return {
      id,
      kind: row.kind,
      timestamp: row.timestamp,
      sequence: row.sequence,
      payload: summary,
      tool: summary,
      ...(legacyTool.output !== undefined ? { toolHasOutput: true } : {}),
    };
  }
  return {
    id,
    kind: row.kind,
    timestamp: row.timestamp,
    sequence: row.sequence,
    payload: legacyTool,
    ...(legacyTool ? { tool: legacyTool } : {}),
  };
}

export function getTranscriptMetaForUser(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
): TranscriptMeta | null {
  const config = getTableConfig(resource);
  const row = getDatabase().prepare(`
    SELECT revision, entry_count
    FROM ${config.metaTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ?
  `).get(resourceId, userId) as { revision: string; entry_count: number } | null;
  return row ? { revision: row.revision, entryCount: row.entry_count } : null;
}

export function getTranscriptMeta(resource: TranscriptResource, resourceId: string): TranscriptMeta | null {
  return getTranscriptMetaForUser(resource, resourceId, requirePersistenceUserId());
}

export function listTranscriptEntriesForUser(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  includeToolPayload = false,
): ChatTranscriptStorageEntry[] {
  const config = getTableConfig(resource);

  const rows = getDatabase().prepare(`
    SELECT entry_id, kind, timestamp, sequence, payload,
      updated_at,
      tool_name, tool_status, ${includeToolPayload ? "tool_input, tool_output, tool_extras" : "tool_input, NULL AS tool_output, NULL AS tool_extras"},
      CASE WHEN tool_output IS NOT NULL THEN 1 ELSE 0 END AS tool_has_output
    FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ?
    ORDER BY timestamp DESC, sequence DESC, kind DESC, entry_id DESC
  `).all(resourceId, userId) as TranscriptRow[];

  return rows.map((row) => rowToStorageEntry(row, includeToolPayload, resource));
}

export function listTranscriptEntries(
  resource: TranscriptResource,
  resourceId: string,
  includeToolPayload = false,
): ChatTranscriptStorageEntry[] {
  return listTranscriptEntriesForUser(
    resource,
    resourceId,
    requirePersistenceUserId(),
    includeToolPayload,
  );
}

export function getTranscriptToolCallForUser(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  toolCallId: string,
): ToolCallRecord | null {
  const config = getTableConfig(resource);
  const row = getDatabase().prepare(`
    SELECT entry_id, kind, timestamp, sequence, payload,
      updated_at,
      tool_name, tool_status, tool_input, tool_output, tool_extras
    FROM ${config.entriesTable}
    WHERE ${config.resourceColumn} = ? AND user_id = ? AND entry_id = ?
    LIMIT 1
  `).get(resourceId, userId, getEntryKey("tool", toolCallId)) as TranscriptRow | null;
  if (!row || row.kind !== "tool") {
    return null;
  }

  if (row.tool_name !== null && row.tool_status !== null) {
    return {
      id: toolCallId,
      name: row.tool_name,
      status: row.tool_status,
      timestamp: row.timestamp,
      detailRevision: row.updated_at,
      ...(row.tool_input !== null
        ? { input: parseJson(row.tool_input, undefined, `${resource}_transcript_tool_input`, row.entry_id) }
        : {}),
      ...(row.tool_output !== null
        ? { output: parseJson(row.tool_output, undefined, `${resource}_transcript_tool_output`, row.entry_id) }
        : {}),
      ...(row.tool_extras !== null
        ? { extras: parseJson(row.tool_extras, [], `${resource}_transcript_tool_extras`, row.entry_id) }
        : {}),
    };
  }

  return parseJson<ToolCallRecord | null>(
    row.payload,
    null,
    `${resource}_transcript_tool_call`,
    row.entry_id,
  );
}

export function getTranscriptToolCall(
  resource: TranscriptResource,
  resourceId: string,
  toolCallId: string,
): ToolCallRecord | null {
  return getTranscriptToolCallForUser(resource, resourceId, requirePersistenceUserId(), toolCallId);
}

export function hydrateTranscriptStateForUser(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
): TranscriptStateLike {
  const entries = listTranscriptEntriesForUser(
    resource,
    resourceId,
    userId,
    true,
  );
  const messages: PersistedMessage[] = [];
  const logs: TaskLogEntry[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (const entry of [...entries].sort((left, right) => left.sequence - right.sequence)) {
    if (entry.kind === "message") {
      if (entry.payload && typeof entry.payload === "object") {
        messages.push(entry.payload as PersistedMessage);
      }
      continue;
    }
    if (entry.kind === "log") {
      if (entry.payload && typeof entry.payload === "object") {
        logs.push(entry.payload as TaskLogEntry);
      }
      continue;
    }

    const tool = entry.tool;
    if (tool) {
      const { detailRevision: _detailRevision, ...persistedTool } = tool;
      toolCalls.push(persistedTool);
    }
  }

  return { messages, logs, toolCalls };
}

export function hydrateTranscriptState(
  resource: TranscriptResource,
  resourceId: string,
): TranscriptStateLike {
  return hydrateTranscriptStateForUser(resource, resourceId, requirePersistenceUserId());
}
