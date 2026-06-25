/**
 * Partial update operations for chats persistence.
 */

import type { ChatConfig, ChatState } from "../../types";
import { createLogger } from "../../core/logger";
import { getDatabase } from "../database";
import { chatToRow, rowToChat, validateChatColumnNames } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:chats");

export async function updateChatState(chatId: string, state: ChatState): Promise<boolean> {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const selectStmt = db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?");

  return db.transaction(() => {
    const row = selectStmt.get(chatId, userId) as Record<string, unknown> | null;
    if (!row) {
      return false;
    }

    const chat = rowToChat(row);
    chat.state = state;
    const newRow = chatToRow(chat);
    const columns = Object.keys(newRow).filter((column) => column !== "id");
    validateChatColumnNames(columns);
    const setClause = columns.map((column) => `${column} = ?`).join(", ");
    const values = columns.map((column) => newRow[column as keyof typeof newRow]) as (string | number | null | Uint8Array)[];
    values.push(chatId, userId);

    db.prepare(`UPDATE chats SET ${setClause} WHERE id = ? AND user_id = ?`).run(...values);
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
