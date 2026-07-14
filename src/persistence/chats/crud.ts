/**
 * Basic CRUD operations for chats persistence.
 */

import type { Chat } from "@/shared";
import { createLogger } from "../../core/logger";
import { getDatabase } from "../database";
import { chatToRow, hasMessageContent, rowToChat, validateChatColumnNames } from "./helpers";
import { requirePersistenceUserId } from "../ownership";

const log = createLogger("persistence:chats");

const CHAT_LIST_COLUMNS = [
  "id",
  "name",
  "source_kind",
  "workspace_id",
  "ssh_server_id",
  "ssh_server_session_id",
  "scope",
  "task_id",
  "directory",
  "created_at",
  "updated_at",
  "is_private",
  "model_provider_id",
  "model_model_id",
  "model_variant",
  "use_worktree",
  "auto_approve_permissions",
  "base_branch",
  "mode",
  "status",
  "started_at",
  "completed_at",
  "last_activity_at",
  "session_id",
  "session_server_url",
  "error_message",
  "error_timestamp",
  "error_code",
  "worktree_original_branch",
  "worktree_working_branch",
  "worktree_path",
  "pending_permission_requests",
  "queued_messages",
  "active_message_id",
  "interrupt_requested",
  "connection_status",
  "CASE WHEN messages IS NOT NULL AND messages <> '[]' THEN 1 ELSE 0 END AS has_messages",
  "CASE WHEN (messages IS NOT NULL AND messages <> '[]') OR (tool_calls IS NOT NULL AND tool_calls <> '[]') THEN 1 ELSE 0 END AS has_transcript",
].join(", ");

export function createChatListSnapshot(chat: Chat): Chat {
  const hasMessages = chat.state.hasMessages ?? chat.state.messages.some(hasMessageContent);
  return {
    config: chat.config,
    state: {
      ...chat.state,
      messages: [],
      logs: [],
      toolCalls: [],
      hasMessages,
      hasTranscript: chat.state.hasTranscript ?? (hasMessages || chat.state.toolCalls.length > 0),
    },
  };
}

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
    WHERE chats.user_id = excluded.user_id
  `).run(...values);
}

export async function loadChat(chatId: string): Promise<Chat | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?")
    .get(chatId, requirePersistenceUserId()) as Record<string, unknown> | null;

  return row ? rowToChat(row) : null;
}

export async function loadTaskChat(taskId: string): Promise<Chat | null> {
  const row = getDatabase()
    .prepare("SELECT * FROM chats WHERE task_id = ? AND scope = 'task' AND user_id = ? LIMIT 1")
    .get(taskId, requirePersistenceUserId()) as Record<string, unknown> | null;

  return row ? rowToChat(row) : null;
}

export async function deleteChat(chatId: string): Promise<boolean> {
  const result = getDatabase().prepare("DELETE FROM chats WHERE id = ? AND user_id = ?").run(chatId, requirePersistenceUserId());
  return result.changes > 0;
}

export async function deleteChatsByTaskId(taskId: string): Promise<number> {
  const result = getDatabase().prepare("DELETE FROM chats WHERE task_id = ? AND user_id = ?").run(taskId, requirePersistenceUserId());
  return result.changes;
}

export async function listChats(): Promise<Chat[]> {
  return listChatSummaries();
}

export async function listChatSummaries(): Promise<Chat[]> {
  const rows = getDatabase()
    .prepare(`SELECT ${CHAT_LIST_COLUMNS} FROM chats WHERE scope = 'workspace' AND user_id = ? ORDER BY created_at DESC`)
    .all(requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map((row) => createChatListSnapshot(rowToChat(row)));
}

export async function listChatsByWorkspace(workspaceId: string): Promise<Chat[]> {
  return listChatSummariesByWorkspace(workspaceId);
}

export async function listChatSummariesByWorkspace(workspaceId: string): Promise<Chat[]> {
  const rows = getDatabase()
    .prepare(`SELECT ${CHAT_LIST_COLUMNS} FROM chats WHERE workspace_id = ? AND scope = 'workspace' AND user_id = ? ORDER BY created_at DESC`)
    .all(workspaceId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map((row) => createChatListSnapshot(rowToChat(row)));
}

export async function listChatsBySshServer(sshServerId: string): Promise<Chat[]> {
  return listChatSummariesBySshServer(sshServerId);
}

export async function listChatSummariesBySshServer(sshServerId: string): Promise<Chat[]> {
  const rows = getDatabase()
    .prepare(`SELECT ${CHAT_LIST_COLUMNS} FROM chats WHERE ssh_server_id = ? AND source_kind = 'ssh_server' AND scope = 'workspace' AND user_id = ? ORDER BY created_at DESC`)
    .all(sshServerId, requirePersistenceUserId()) as Record<string, unknown>[];
  return rows.map((row) => createChatListSnapshot(rowToChat(row)));
}

export async function getWorkspaceChatNameStats(
  workspaceId: string,
  generatedNamePrefix: string,
): Promise<{ standaloneChatCount: number; maxGeneratedSuffix: number }> {
  const suffixStart = generatedNamePrefix.length + " - ".length + 1;
  const row = getDatabase()
    .prepare(`
      SELECT
        COUNT(*) AS standalone_chat_count,
        COALESCE(MAX(
          CASE
            WHEN substr(name, 1, ?) = ?
              AND substr(name, ?, 3) = ' - '
              AND length(name) >= ?
              AND substr(name, ?) NOT GLOB '*[^0-9]*'
            THEN CAST(substr(name, ?) AS INTEGER)
          END
        ), 0) AS max_generated_suffix
      FROM chats
      WHERE workspace_id = ? AND scope = 'workspace' AND user_id = ?
    `)
    .get(
      generatedNamePrefix.length,
      generatedNamePrefix,
      generatedNamePrefix.length + 1,
      suffixStart,
      suffixStart,
      suffixStart,
      workspaceId,
      requirePersistenceUserId(),
    ) as { standalone_chat_count: number; max_generated_suffix: number } | null;

  return {
    standaloneChatCount: row?.standalone_chat_count ?? 0,
    maxGeneratedSuffix: row?.max_generated_suffix ?? 0,
  };
}

export async function chatExists(chatId: string): Promise<boolean> {
  return getDatabase().prepare("SELECT 1 FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(chatId, requirePersistenceUserId()) !== null;
}
