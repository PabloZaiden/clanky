/**
 * Specialized query operations for chats persistence.
 */

import type { Chat, ChatStatus } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { rowToChat } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:chats");
const STALE_CHAT_RESET_MESSAGE = "Forcefully stopped by connection reset";

const ACTIVE_CHAT_STATUSES: ChatStatus[] = [
  "idle",
  "starting",
  "streaming",
  "interrupting",
  "reconnecting",
];

const STALE_CHAT_STATUSES: ChatStatus[] = [
  "starting",
  "streaming",
  "interrupting",
  "reconnecting",
];

export async function getActiveChatByDirectory(directory: string, workspaceId: string): Promise<Chat | null> {
  const placeholders = ACTIVE_CHAT_STATUSES.map(() => "?").join(", ");
  const userId = requirePersistenceUserId();
  const row = getDatabase().prepare(`
    SELECT * FROM chats
    WHERE directory = ? AND workspace_id = ? AND user_id = ? AND scope = 'workspace' AND status IN (${placeholders})
    LIMIT 1
  `).get(directory, workspaceId, userId, ...ACTIVE_CHAT_STATUSES) as Record<string, unknown> | null;

  return row ? rowToChat(row) : null;
}

export function isStaleChatStatus(status: ChatStatus): boolean {
  return STALE_CHAT_STATUSES.includes(status);
}

export async function resetStaleChat(chatId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const placeholders = STALE_CHAT_STATUSES.map(() => "?").join(", ");
  const userId = requirePersistenceUserId();
  const result = getDatabase().prepare(`
    UPDATE chats
    SET status = 'stopped',
        error_message = ?,
        error_timestamp = ?,
        completed_at = ?,
        interrupt_requested = 0
    WHERE id = ? AND user_id = ? AND status IN (${placeholders})
  `).run(STALE_CHAT_RESET_MESSAGE, now, now, chatId, userId, ...STALE_CHAT_STATUSES);

  if (result.changes > 0) {
    log.info("Reset stale chat", { chatId });
    return true;
  }

  return false;
}

export async function resetStaleChats(): Promise<number> {
  const now = new Date().toISOString();
  const placeholders = STALE_CHAT_STATUSES.map(() => "?").join(", ");
  const userId = requirePersistenceUserId();
  const result = getDatabase().prepare(`
    UPDATE chats
    SET status = 'stopped',
        error_message = ?,
        error_timestamp = ?,
        completed_at = ?,
        interrupt_requested = 0
    WHERE user_id = ? AND status IN (${placeholders})
  `).run(STALE_CHAT_RESET_MESSAGE, now, now, userId, ...STALE_CHAT_STATUSES);

  return result.changes;
}
