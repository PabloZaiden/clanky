/**
 * Specialized query operations for chats persistence.
 */

import type { Chat, ChatStatus } from "@/shared";
import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "../database";
import { rowToChat } from "./helpers";
import { CHAT_METADATA_COLUMNS } from "./crud";
import { requirePersistenceUserId } from "../ownership";
import { chatTranscriptStore } from "../transcripts/chat-store";
import { parseStoredHarnessState } from "../harness-binding";
import { closeOpenQuestions } from "@/shared/harness-questions";

const log = createLogger("persistence:chats");
const STALE_CHAT_RESET_MESSAGE = "Forcefully stopped by connection reset";

const ACTIVE_CHAT_STATUSES: ChatStatus[] = [
  "idle",
  "starting",
  "streaming",
  "waiting",
  "interrupting",
  "reconnecting",
];

const STALE_CHAT_STATUSES: ChatStatus[] = [
  "starting",
  "streaming",
  "waiting",
  "interrupting",
  "reconnecting",
];

export async function getActiveChatByDirectory(directory: string, workspaceId: string): Promise<Chat | null> {
  const placeholders = ACTIVE_CHAT_STATUSES.map(() => "?").join(", ");
  const userId = requirePersistenceUserId();
  const row = getDatabase().prepare(`
    SELECT ${CHAT_METADATA_COLUMNS} FROM chats
    WHERE directory = ? AND workspace_id = ? AND user_id = ? AND scope = 'workspace' AND status IN (${placeholders})
    LIMIT 1
  `).get(directory, workspaceId, userId, ...ACTIVE_CHAT_STATUSES) as Record<string, unknown> | null;

  if (!row) {
    return null;
  }
  const chat = rowToChat(row);
  const transcript = chatTranscriptStore.hydrateForUser(chat.config.id, userId);
  chat.state.messages = transcript.messages;
  chat.state.logs = transcript.logs;
  chat.state.toolCalls = transcript.toolCalls;
  return chat;
}

export function isStaleChatStatus(status: ChatStatus): boolean {
  return STALE_CHAT_STATUSES.includes(status);
}

function resetStale(chatId?: string): number {
  const now = new Date().toISOString();
  const placeholders = STALE_CHAT_STATUSES.map(() => "?").join(", ");
  const userId = requirePersistenceUserId();
  const db = getDatabase();
  return db.transaction(() => {
    const rows = db.query<{ id: string; harness_state_json: string | null }, (string)[]>(`
      SELECT id, harness_state_json FROM chats WHERE user_id = ? AND status IN (${placeholders})
      ${chatId ? "AND id = ?" : ""}
    `).all(userId, ...STALE_CHAT_STATUSES, ...(chatId ? [chatId] : []));
    for (const row of rows) {
      const harness = parseStoredHarnessState(row.harness_state_json, row.id);
      if (harness?.questions?.length) db.query("UPDATE chats SET harness_state_json = ? WHERE id = ? AND user_id = ?")
        .run(JSON.stringify({ ...harness, questions: closeOpenQuestions(harness.questions, "expired") }), row.id, userId);
    }
    const result = db.prepare(`
    UPDATE chats
    SET status = 'stopped',
        error_message = ?,
        error_timestamp = ?,
        completed_at = ?,
        interrupt_requested = 0,
        active_message_id = NULL,
        pending_permission_requests = '[]',
        connection_status = 'disconnected',
        startup_stage = NULL
    WHERE user_id = ? AND status IN (${placeholders}) ${chatId ? "AND id = ?" : ""}
  `).run(STALE_CHAT_RESET_MESSAGE, now, now, userId, ...STALE_CHAT_STATUSES, ...(chatId ? [chatId] : []));
    return result.changes;
  })();
}

export async function resetStaleChat(chatId: string): Promise<boolean> {
  const changed = resetStale(chatId);
  if (changed) log.info("Reset stale chat", { chatId });
  return changed > 0;
}

export async function resetStaleChats(): Promise<number> {
  return resetStale();
}
