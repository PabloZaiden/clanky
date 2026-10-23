/**
 * Owner-scoped chat Trash metadata and atomic lifecycle fences.
 */
import type { Chat, ChatWorktreeState } from "@/shared/chat";
import { CHAT_TRASH_RETENTION_MS } from "@/shared/chat";
import type { ChatTrashPage, ChatTrashQuery } from "@/contracts/schemas/chat-trash";
import { decodeChatTrashCursor, encodeChatTrashCursor } from "@/contracts/schemas/chat-trash";
import { getDatabase } from "../database";
import { getPersistenceWorkspaceId, requireResourcePersistenceUserId } from "../ownership";
import { CHAT_METADATA_COLUMNS } from "./crud";
import { rowToChat } from "./helpers";
import { closeOpenQuestions } from "@/shared/harness-questions";
import { projectQuestionMessages } from "@/shared/question-transcript";
import { createTranscriptChangeSet } from "@/shared/chat-transcript";
import type { TranscriptChangeSet } from "@/shared/chat-transcript";
import { chatTranscriptStore } from "../transcripts/chat-store";
import { parseStoredHarnessState } from "../harness-binding";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { invalidateChatMetadata } from "./metadata-cache";

const STANDALONE = "scope = 'workspace' AND task_id IS NULL";
export function loadTrashedChat(chatId: string): Chat | null {
  const row = getDatabase().prepare(`
    SELECT ${CHAT_METADATA_COLUMNS} FROM chats
    WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND ${STANDALONE}
  `).get(chatId, requireResourcePersistenceUserId("chat", chatId)) as Record<string, unknown> | null;
  return row ? rowToChat(row) : null;
}

export function listChatTrash(options: ChatTrashQuery): ChatTrashPage {
  const cursor = options.cursor ? decodeChatTrashCursor(options.cursor) : undefined;
  const values: (string | number)[] = [requireResourcePersistenceUserId("chat")];
  const conditions = ["chat.user_id = ?", "chat.deleted_at IS NOT NULL", "chat.scope = 'workspace'", "chat.task_id IS NULL"];
  const workspaceId = getPersistenceWorkspaceId();
  if (workspaceId) { conditions.push("chat.workspace_id = ?"); values.push(workspaceId); }
  if (cursor) {
    if (cursor.timestampBoundary) {
      conditions.push(cursor.timestampBoundary === "inclusive" ? "chat.deleted_at <= ?" : "chat.deleted_at < ?");
      values.push(cursor.deletedAt);
    } else {
      conditions.push("(chat.deleted_at, chat.id) < (?, ?)");
      values.push(cursor.deletedAt, cursor.id);
    }
  }
  const privateExpression = "(chat.is_private OR COALESCE(workspace.is_private, 0) OR COALESCE(server.is_private, 0))";
  if (options.includePrivate === "false") conditions.push(`${privateExpression} = 0`);
  values.push(options.limit + 1);
  const rows = getDatabase().prepare(`
    SELECT chat.id, chat.name, chat.workspace_id AS workspaceId,
      COALESCE(workspace.name, server.name, host.source_id, chat.directory) AS origin,
      ${privateExpression} AS isPrivate, chat.deleted_at AS deletedAt,
      chat.harness_state_json AS harnessState, host.kind AS hostKind, host.source_id AS hostSourceId
    FROM chats chat
    LEFT JOIN workspaces workspace ON workspace.id = chat.workspace_id AND workspace.user_id = chat.user_id
    LEFT JOIN execution_hosts host ON host.id = chat.execution_host_id AND host.user_id = chat.user_id
    LEFT JOIN ssh_servers server ON host.kind = 'ssh' AND server.id = host.source_id AND server.user_id = chat.user_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY chat.deleted_at DESC, chat.id DESC LIMIT ?
  `).all(...values) as Array<{
    id: string; name: string; workspaceId: string | null; origin: string;
    isPrivate: number; deletedAt: string;
    harnessState: string | null; hostKind: string | null; hostSourceId: string | null;
  }>;
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit).map((row) => {
    const { harnessState, hostKind, hostSourceId, ...item } = row;
    const recovery = parseStoredHarnessState(harnessState, item.id)?.historyRecovery;
    const recoveryServerId = recovery && recovery.status !== "complete"
      ? getRegisteredSshServerId(recovery.executionHost.host) : null;
    return {
      ...item,
      isPrivate: Boolean(item.isPrivate),
      expiresAt: new Date(Date.parse(item.deletedAt) + CHAT_TRASH_RETENTION_MS).toISOString(),
      credentialServerIds: [...new Set([
        ...(hostKind === "ssh" && hostSourceId ? [hostSourceId] : []),
        ...(recoveryServerId ? [recoveryServerId] : []),
      ])],
    };
  });
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last
      ? encodeChatTrashCursor({ deletedAt: last.deletedAt, id: last.id })
      : null,
  };
}

export function markChatTrashed(chatId: string, checkpoint?: TranscriptChangeSet): Chat | null {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  invalidateChatMetadata(db, userId, chatId);
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT ${CHAT_METADATA_COLUMNS} FROM chats
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND ${STANDALONE}
    `).get(chatId, userId) as Record<string, unknown> | null;
    if (!row) return null;
    const chat = rowToChat(row);
    if (checkpoint) {
      chatTranscriptStore.applyChangeSetInTransaction(db, chatId, userId, checkpoint);
    }
    const now = new Date().toISOString();
    const questions = closeOpenQuestions(chat.state.harness?.questions, "cancelled", { includeQueued: true });
    if (questions?.some((question) => question.transcript)) {
      const transcript = chatTranscriptStore.hydrateForUser(chatId, userId);
      const updates = projectQuestionMessages(transcript.messages, questions);
      chatTranscriptStore.applyChangeSetInTransaction(db, chatId, userId, createTranscriptChangeSet(
        transcript,
        updates.map((message) => ({ id: message.id, kind: "message", timestamp: message.timestamp, payload: message })),
      ));
    }
    const harness = chat.state.harness
      ? { ...chat.state.harness, questions, inputs: [], activeTurnAttachmentBytes: 0 }
      : undefined;
    db.prepare(`
      UPDATE chats SET deleted_at = ?, state_revision = state_revision + 1,
        status = CASE WHEN status IN ('starting', 'streaming', 'waiting', 'interrupting', 'reconnecting') THEN 'stopped' ELSE status END,
        connection_status = 'disconnected', startup_stage = NULL, active_message_id = NULL,
        interrupt_requested = 0, pending_permission_requests = '[]', queued_messages = '[]',
        harness_state_json = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(now, harness ? JSON.stringify(harness) : null, chatId, userId);
    return loadTrashedChat(chatId);
  })();
}

export function restoreTrashedChat(chatId: string, deletedAt: string): boolean {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  invalidateChatMetadata(db, userId, chatId);
  return db.prepare(`
    UPDATE chats SET deleted_at = NULL, state_revision = state_revision + 1
    WHERE id = ? AND user_id = ? AND deleted_at = ? AND ${STANDALONE}
  `).run(chatId, userId, deletedAt).changes > 0;
}

export function deleteTrashedChat(chatId: string, deletedAt: string): boolean {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  invalidateChatMetadata(db, userId, chatId);
  return db.prepare(`
    DELETE FROM chats WHERE id = ? AND user_id = ? AND deleted_at = ? AND ${STANDALONE}
  `).run(chatId, userId, deletedAt).changes > 0;
}

export function saveTrashedChatWorktree(chatId: string, worktree: ChatWorktreeState): boolean {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", chatId);
  invalidateChatMetadata(db, userId, chatId);
  return db.prepare(`
    UPDATE chats SET worktree_original_branch = ?, worktree_working_branch = ?,
      worktree_path = ?, state_revision = state_revision + 1
    WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND ${STANDALONE}
  `).run(worktree.originalBranch, worktree.workingBranch, worktree.worktreePath ?? null,
    chatId, userId).changes > 0;
}

export function listTrashCleanupCandidates(options: {
  cutoff: string;
  after?: { id: string; deletedAt: string };
  workspaceId?: string;
}): Array<{ id: string; deletedAt: string }> {
  const conditions = ["user_id = ?", "deleted_at <= ?", STANDALONE];
  const values: string[] = [requireResourcePersistenceUserId("chat", undefined, options.workspaceId), options.cutoff];
  const scopeWorkspaceId = getPersistenceWorkspaceId();
  if (scopeWorkspaceId) { conditions.push("workspace_id = ?"); values.push(scopeWorkspaceId); }
  if (options.after) {
    conditions.push("(deleted_at, id) > (?, ?)");
    values.push(options.after.deletedAt, options.after.id);
  }
  if (options.workspaceId) {
    conditions.push("workspace_id = ?");
    values.push(options.workspaceId);
  }
  return getDatabase().prepare(`
    SELECT id, deleted_at AS deletedAt FROM chats WHERE ${conditions.join(" AND ")}
    ORDER BY deleted_at, id LIMIT 30
  `).all(...values) as Array<{ id: string; deletedAt: string }>;
}
