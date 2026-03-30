/**
 * Basic CRUD operations for chats persistence.
 */

import type { Chat } from "../../types";
import { createLogger } from "../../core/logger";
import { getDatabase } from "../database";
import { chatToRow, rowToChat, validateChatColumnNames } from "./helpers";

const log = createLogger("persistence:chats");

export async function saveChat(chat: Chat): Promise<void> {
  log.debug("Saving chat", { id: chat.config.id, name: chat.config.name, status: chat.state.status });
  const db = getDatabase();
  const row = chatToRow(chat);
  const columns = Object.keys(row);
  validateChatColumnNames(columns);
  const placeholders = columns.map(() => "?").join(", ");
  const values = Object.values(row) as (string | number | null | Uint8Array)[];
  const updateColumns = columns.filter((column) => column !== "id");
  const updateClause = updateColumns.map((column) => `${column} = excluded.${column}`).join(", ");

  db.prepare(`
    INSERT INTO chats (${columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateClause}
  `).run(...values);
}

export async function loadChat(chatId: string): Promise<Chat | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM chats WHERE id = ?")
    .get(chatId) as Record<string, unknown> | null;

  return row ? rowToChat(row) : null;
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM chats WHERE id = ?").run(chatId);
  return result.changes > 0;
}

export async function listChats(): Promise<Chat[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM chats ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToChat);
}

export async function listChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
  const rows = getDatabase()
    .prepare("SELECT * FROM chats WHERE workspace_id = ? ORDER BY created_at DESC")
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(rowToChat);
}

export async function chatExists(chatId: string): Promise<boolean> {
  return getDatabase().prepare("SELECT 1 FROM chats WHERE id = ? LIMIT 1").get(chatId) !== null;
}
