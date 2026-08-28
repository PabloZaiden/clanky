/**
 * Partial update operations for chats persistence.
 */

import type { ChatConfig, ChatState, ChatStatus, TranscriptChangeSet } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { chatToRow, rowToChat, validateChatColumnNames } from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import { syncChatTranscriptEntriesInTransaction } from "./transcript";
import {
  applyTranscriptChangeSetInTransaction,
  hydrateTranscriptStateForUser,
} from "../transcripts/store";
import { CHAT_METADATA_COLUMNS } from "./crud";

const log = createLogger("persistence:chats");

export interface UpdateChatStateOptions {
  preserveQueuedMessages?: boolean;
  previousState?: ChatState;
  transcriptChanges?: TranscriptChangeSet;
  expectedStatus?: ChatStatus;
}

export async function updateChatState(chatId: string, state: ChatState, options: UpdateChatStateOptions = {}): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const selectStmt = db.prepare(`SELECT ${CHAT_METADATA_COLUMNS} FROM chats WHERE id = ? AND user_id = ?`);
  const saved = db.transaction(() => {
    const row = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
    if (!row) {
      return false;
    }

    const chat = rowToChat(row);
    if (options.expectedStatus !== undefined && chat.state.status !== options.expectedStatus) {
      return false;
    }
    chat.state = state;
    const newRow = chatToRow(chat);
    const columns = Object.keys(newRow).filter((column) => {
      if (column === "id") {
        return false;
      }
      return !(options.preserveQueuedMessages && column === "queued_messages");
    });
    validateChatColumnNames(columns);
    const setClause = columns.map((column) => `${column} = ?`).join(", ");
    const values = columns.map((column) => newRow[column as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(chatId, userId);
    const statusCondition = options.expectedStatus === undefined ? "" : " AND status = ?";
    if (options.expectedStatus !== undefined) {
      values.push(options.expectedStatus);
    }

    const result = db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ?${statusCondition}`).run(...values);
    if (result.changes === 0 && options.expectedStatus !== undefined) {
      const latestRow = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
      if (!latestRow || latestRow["status"] !== options.expectedStatus) {
        return false;
      }
    }
    if (options.transcriptChanges) {
      applyTranscriptChangeSetInTransaction(
        db,
        "chat",
        chatId,
        userId,
        options.transcriptChanges,
      );
    } else {
      const previousState = options.previousState ?? (() => {
        const transcript = hydrateTranscriptStateForUser("chat", chatId, userId);
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
    return true;
  })();
  return saved;
}

export async function updateChatConfig(
  chatId: string,
  config: ChatConfig,
  options: { expectedName?: string } = {},
): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const selectStmt = db.prepare(`SELECT ${CHAT_METADATA_COLUMNS} FROM chats WHERE id = ? AND user_id = ?`);

  const saved = db.transaction(() => {
    const row = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
    if (!row) {
      return false;
    }

    const chat = rowToChat(row);
    chat.config = config;
    const newRow = chatToRow(chat);
    const columns = Object.keys(newRow).filter((column) => column !== "id");
    validateChatColumnNames(columns);
    const setClause = columns.map((column) => `${column} = ?`).join(", ");
    const values = columns.map((column) => newRow[column as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(chatId, userId);
    const nameCondition = options.expectedName === undefined ? "" : " AND name = ?";
    if (options.expectedName !== undefined) {
      values.push(options.expectedName);
    }

    const result = db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ?${nameCondition}`).run(...values);
    if (result.changes === 0) {
      log.debug("Chat config update did not modify a row", {
        chatId,
        expectedNameGuarded: options.expectedName !== undefined,
      });
      return false;
    }
    log.debug("Chat config updated", { chatId, name: config.name });
    return true;
  })();
  return saved;
}
