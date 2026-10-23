/**
 * Partial update operations for chats persistence.
 */

import type { Chat, ChatConfig, ChatState, ChatStatus, TranscriptChangeSet } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { chatStateToRow, chatToRow, rowToChat, validateChatColumnNames } from "./helpers";
import type { PersistedChatStateField } from "./helpers";
import { requireResourcePersistenceUserId } from "../ownership";
import { syncChatTranscriptEntriesInTransaction } from "./transcript";
import { chatTranscriptStore } from "../transcripts/chat-store";
import { CHAT_METADATA_COLUMNS } from "./crud";
import { beginChatMetadataWrite, cacheChatMetadata, invalidateChatMetadata } from "./metadata-cache";
import { parseStoredHarnessState } from "../harness-binding";

const log = createLogger("persistence:chats");
const STREAM_STATE_FIELDS = new Set<PersistedChatStateField>(["lastActivityAt"]);

export interface UpdateChatStateOptions {
  preserveQueuedMessages?: boolean;
  preserveHarnessState?: boolean;
  previousState?: ChatState;
  transcriptChanges?: TranscriptChangeSet;
  expectedStatus?: ChatStatus;
}

interface PersistedChatState {
  chat: Chat;
  previousStatus: ChatStatus;
}

/**
 * Persist a live stream mutation without rebuilding the full chat row.
 *
 * Tool events already have the current transcript in memory and only own
 * last_activity_at in the chat metadata. Keeping this path separate prevents
 * a stream event from overwriting metadata changed by another operation.
 */
export async function updateChatStreamState(
  chatId: string,
  lastActivityAt: string | undefined,
  options: Pick<UpdateChatStateOptions, "transcriptChanges" | "expectedStatus"> = {},
): Promise<PersistedChatState | null> {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  const commitCache = beginChatMetadataWrite(db, userId, chatId);
  const statusCondition = options.expectedStatus === undefined ? "" : " AND status = ?";
  const updateStmt = db.query<{ status: ChatStatus; state_revision: number }, (string | null)[]>(`
    UPDATE chats
    SET last_activity_at = ?, state_revision = state_revision + 1
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL${statusCondition}
    RETURNING status, state_revision
  `);
  const selectStmt = db.query(
    `SELECT ${CHAT_METADATA_COLUMNS} FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  );

  const saved = db.transaction(() => {
    const values: (string | null)[] = [lastActivityAt ?? null, chatId, userId];
    if (options.expectedStatus !== undefined) {
      values.push(options.expectedStatus);
    }
    const result = updateStmt.get(...values);
    if (!result) return null;

    if (options.transcriptChanges) {
      chatTranscriptStore.applyChangeSetInTransaction(
        db,
        chatId,
        userId,
        options.transcriptChanges,
      );
    }
    return {
      chat: rowToChat(selectStmt.get(chatId, userId) as Record<string, unknown>),
      previousStatus: result.status,
      previousRevision: result.state_revision - 1,
    };
  })();
  if (saved) commitCache(saved.chat, saved.previousRevision, STREAM_STATE_FIELDS);
  return saved;
}

export async function updateChatState(chatId: string, state: ChatState, options: UpdateChatStateOptions = {}): Promise<PersistedChatState | null> {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  const writesHarness = !options.preserveHarnessState
    && (!options.previousState || state.harness !== options.previousState.harness);
  const mergeHarness = writesHarness && Boolean(state.harness && options.previousState);
  const needsCurrentState = state.status !== options.previousState?.status || mergeHarness;
  const commitCache = beginChatMetadataWrite(db, userId, chatId);
  const selectStmt = db.query(`SELECT ${CHAT_METADATA_COLUMNS} FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL`);
  const saved = db.transaction(() => {
    const row = needsCurrentState ? db.query<{ status: ChatStatus; harness_state_json?: string | null }, [string, string]>(
      `SELECT status${mergeHarness ? ", harness_state_json" : ""} FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ).get(chatId, userId) : undefined;
    if (needsCurrentState && !row) return null;
    if (row && options.expectedStatus !== undefined && row.status !== options.expectedStatus) return null;
    let nextState = state;
    if (mergeHarness && state.harness && options.previousState) {
      const previousHarness = parseStoredHarnessState(row!.harness_state_json, chatId);
      nextState = {
        ...state,
        harness: {
          ...state.harness,
          activity: state.harness.activity === options.previousState.harness?.activity ? previousHarness?.activity : state.harness.activity,
          cleanup: state.harness.cleanup === options.previousState.harness?.cleanup ? previousHarness?.cleanup : state.harness.cleanup,
          capabilities: state.harness.capabilities === options.previousState.harness?.capabilities ? previousHarness?.capabilities : state.harness.capabilities,
          gitSafety: state.harness.gitSafety === options.previousState.harness?.gitSafety ? previousHarness?.gitSafety : state.harness.gitSafety,
          gitOutcome: state.harness.gitOutcome === options.previousState.harness?.gitOutcome ? previousHarness?.gitOutcome : state.harness.gitOutcome,
          inputs: state.harness.inputs === options.previousState.harness?.inputs ? previousHarness?.inputs : state.harness.inputs,
          questions: state.harness.questions === options.previousState.harness?.questions ? previousHarness?.questions : state.harness.questions,
          integrity: previousHarness?.integrity ?? state.harness.integrity,
        },
      };
    }
    const write = chatStateToRow(nextState, options);
    const columns = Object.keys(write.row);
    validateChatColumnNames(columns);
    const setClause = [...columns.map((column) => `${column} = ?`), "state_revision = state_revision + 1"].join(", ");
    const values = Object.values(write.row);
    values.push(chatId, userId);
    const statusCondition = options.expectedStatus === undefined ? "" : " AND status = ?";
    if (options.expectedStatus !== undefined) {
      values.push(options.expectedStatus);
    }

    const result = db.query<{ status: ChatStatus; state_revision: number }, (string | number | null)[]>(
      `UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ? AND deleted_at IS NULL${statusCondition} RETURNING status, state_revision`,
    ).get(...values);
    if (!result) return null;
    if (options.transcriptChanges) {
      chatTranscriptStore.applyChangeSetInTransaction(
        db,
        chatId,
        userId,
        options.transcriptChanges,
      );
    } else {
      const previousState = options.previousState ?? (() => {
        const transcript = chatTranscriptStore.hydrateForUser(chatId, userId);
        return {
          ...state,
          messages: transcript.messages,
          logs: transcript.logs,
          toolCalls: transcript.toolCalls,
        };
      })();
      syncChatTranscriptEntriesInTransaction(db, chatId, previousState, state);
    }
    log.debug("Chat state updated", { chatId, status: state.status });
    return {
      chat: rowToChat(selectStmt.get(chatId, userId) as Record<string, unknown>),
      previousStatus: row?.status ?? result.status,
      previousRevision: result.state_revision - 1,
      fields: write.fields,
    };
  })();
  if (saved) commitCache(saved.chat, saved.previousRevision, saved.fields);
  return saved;
}

export async function updateChatConfig(
  chatId: string,
  config: ChatConfig,
  options: { expectedName?: string } = {},
): Promise<boolean> {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId, config.workspaceId ?? null);
  invalidateChatMetadata(db, userId, chatId);
  const selectStmt = db.prepare(`SELECT ${CHAT_METADATA_COLUMNS} FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL`);

  const saved = db.transaction(() => {
    const row = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
    if (!row) {
      return null;
    }

    const chat = rowToChat(row);
    config.creator = chat.config.creator;
    chat.config = config;
    const newRow = chatToRow(chat);
    const columns = Object.keys(newRow).filter((column) => column !== "id" && column !== "state_revision");
    validateChatColumnNames(columns);
    const setClause = [...columns.map((column) => `${column} = ?`), "state_revision = state_revision + 1"].join(", ");
    const values = columns.map((column) => newRow[column as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(chatId, userId);
    const nameCondition = options.expectedName === undefined ? "" : " AND name = ?";
    if (options.expectedName !== undefined) {
      values.push(options.expectedName);
    }

    const result = db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ? AND deleted_at IS NULL${nameCondition}`).run(...values);
    if (result.changes === 0) {
      log.debug("Chat config update did not modify a row", {
        chatId,
        expectedNameGuarded: options.expectedName !== undefined,
      });
      return null;
    }
    log.debug("Chat config updated", { chatId, name: config.name });
    return rowToChat(selectStmt.get(chatId, userId) as Record<string, unknown>);
  })();
  if (saved) cacheChatMetadata(db, userId, saved);
  return saved !== null;
}
