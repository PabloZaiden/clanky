import { getDatabase } from "./database";
import { requireResourcePersistenceUserId } from "./ownership";
import { applyTranscriptChangeSetInTransaction, getTranscriptMetaForUser } from "./transcripts/sql-store";
import type { HtmlRenderReference } from "@/shared/html-render";
import type { ConversationLogEntry } from "@/shared/conversation";
import { DomainError } from "@/domain/domain-error";

export interface HtmlAttachmentReference {
  messageId: string; attachmentId: string; filename: string; reference: string;
}

export function listHtmlAttachmentReferences(chatId: string, filename?: string): HtmlAttachmentReference[] {
  const userId = requireResourcePersistenceUserId("chat", chatId);
  const rows = getDatabase().query(`
    SELECT json_extract(entry.payload, '$.id') AS messageId,
      json_extract(attachment.value, '$.id') AS attachmentId,
      json_extract(attachment.value, '$.filename') AS filename
    FROM chat_transcript_entries entry, json_each(entry.payload, '$.attachments') attachment
    WHERE entry.chat_id = ? AND entry.user_id = ? AND entry.kind = 'message'
      AND (? IS NULL OR json_extract(attachment.value, '$.filename') = ?)
    ORDER BY entry.timestamp DESC, entry.sequence DESC
    LIMIT ?
  `).all(chatId, userId, filename ?? null, filename ?? null, filename ? 2 : 20) as Omit<HtmlAttachmentReference, "reference">[];
  return rows.map((row) => ({ ...row, reference: `attachment:${row.messageId}/${row.attachmentId}` }));
}

export function saveHtmlRender(reference: HtmlRenderReference, html: string): ConversationLogEntry {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId("chat", reference.chatId);
  const timestamp = new Date().toISOString();
  const log: ConversationLogEntry = {
    id: `html-render-${reference.id}`, level: "agent", message: reference.title,
    timestamp, details: { logKind: "html-render", htmlRender: reference },
  };
  db.transaction(() => {
    const inserted = db.query(`
      INSERT INTO html_renders (id, chat_id, user_id, title, height, html, created_at)
      SELECT ?, id, user_id, ?, ?, ?, ? FROM chats WHERE id = ? AND user_id = ?
    `).run(reference.id, reference.title, reference.height, html, timestamp, reference.chatId, userId);
    if (inserted.changes !== 1) throw new DomainError("html_chat_unavailable", "The originating chat is unavailable.");
    const meta = getTranscriptMetaForUser("chat", reference.chatId, userId);
    applyTranscriptChangeSetInTransaction(db, "chat", reference.chatId, userId, {
      upserts: [{ id: log.id, kind: "log", timestamp, payload: log }],
      deletes: [], entryCount: (meta?.entryCount ?? 0) + 1,
    });
  })();
  return log;
}

export function readHtmlRender(chatId: string, artifactId: string): string | null {
  const row = getDatabase().query("SELECT html FROM html_renders WHERE id = ? AND chat_id = ? AND user_id = ?")
    .get(artifactId, chatId, requireResourcePersistenceUserId("chat", chatId)) as { html: string } | null;
  return row?.html ?? null;
}
