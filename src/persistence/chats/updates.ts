/**
 * Partial update operations for chats persistence.
 */

import type { ChatConfig, ChatState } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { chatToRow, rowToChat, validateChatColumnNames } from "./helpers";
import { requirePersistenceUserId } from "../ownership";
import { syncChatTranscriptEntriesInTransaction } from "./transcript";

const log = createLogger("persistence:chats");

interface UpdateChatStateOptions {
  preserveQueuedMessages?: boolean;
  previousState?: ChatState;
}

export async function updateChatState(chatId: string, state: ChatState, options: UpdateChatStateOptions = {}): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const selectStmt = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?");

  return db.transaction(() => {
    const row = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
    if (!row) {
      return false;
    }

    const chat = rowToChat(row);
    const previousState = options.previousState ?? chat.state;
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

    db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ?`).run(...values);
    syncChatTranscriptEntriesInTransaction(db, chatId, previousState, state);
    log.debug("Chat state updated", { chatId, status: state.status });
    return true;
  })();
}

export async function updateChatConfig(chatId: string, config: ChatConfig): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const selectStmt = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?");

  return db.transaction(() => {
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

    db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ?`).run(...values);
    log.debug("Chat config updated", { chatId, name: config.name });
    return true;
  })();
}
