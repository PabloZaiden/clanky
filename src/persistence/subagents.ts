import { z } from "zod";
import type { HarnessActivity, HarnessConversationBinding } from "@/shared/harness-control";
import type { Subagent, SubagentContext, SubagentList } from "@/shared/subagent";
import { SubagentSchema } from "@/contracts/schemas/subagent";
import { TRANSCRIPT_PAGE_SIZE } from "@/shared/chat-transcript";
import { DomainError } from "../domain/domain-error";
import { getDatabase } from "./database";
import { requireResourcePersistenceUserId } from "./ownership";
import { subagentTranscriptStore } from "./transcripts/subagent-store";
import type { TaskLogEntry, TranscriptEntryUpsert } from "@/shared";
import { isTaskLogEntry } from "./transcripts/codec";

interface SubagentRow { record_json: string }

function decode(row: SubagentRow): Subagent {
  try {
    return SubagentSchema.parse(JSON.parse(row.record_json));
  } catch (cause) {
    throw new DomainError("harness_event_gap", "A saved subagent record is invalid.", { cause });
  }
}

function sourceKey(context: SubagentContext, binding: HarnessConversationBinding, activityId: string): string {
  return JSON.stringify([context.kind, context.id, binding.adapter, binding.nativeId, binding.executionHost ?? null, activityId]);
}

export function getSubagentForContext(context: SubagentContext, id: string): Subagent | null {
  const userId = requireResourcePersistenceUserId(context.kind, context.id);
  const column = context.kind === "chat" ? "chat_id" : "task_id";
  const row = getDatabase().query<SubagentRow, [string, string, string]>(
    `SELECT record_json FROM harness_subagents WHERE id = ? AND user_id = ? AND ${column} = ?`,
  ).get(id, userId, context.id);
  return row ? decode(row) : null;
}

export function retainSubagent(context: SubagentContext, binding: HarnessConversationBinding, activity: HarnessActivity): Subagent {
  const db = getDatabase();
  const userId = requireResourcePersistenceUserId(context.kind, context.id);
  if (binding.ownerId !== userId || binding.contextId !== context.id || activity.kind !== "subagent" || activity.ownership !== "owned") {
    throw new DomainError("harness_session_not_owned", "Subagent capture requires an owned parent and child.");
  }
  const key = sourceKey(context, binding, activity.id);
  const existing = db.query<SubagentRow, [string, string]>(
    "SELECT record_json FROM harness_subagents WHERE user_id = ? AND source_key = ?",
  ).get(userId, key);
  if (existing) return decode(existing);
  const table = context.kind === "chat" ? "chats" : "tasks";
  const parent = db.query<{ workspace_id: string | null }, [string, string]>(
    `SELECT workspace_id FROM ${table} WHERE id = ? AND user_id = ?${context.kind === "chat" ? " AND deleted_at IS NULL" : ""}`,
  ).get(context.id, userId);
  if (!parent) throw new DomainError("harness_session_not_found", "The subagent parent is unavailable.");
  const now = new Date().toISOString();
  const subagent: Subagent = {
    id: crypto.randomUUID(),
    ...(context.kind === "chat" ? { chatId: context.id } : { taskId: context.id }),
    workspaceId: parent.workspace_id,
    binding, activity, coverage: "partial", observation: "connected",
    createdAt: now, updatedAt: now,
  };
  db.transaction(() => {
    db.query(`INSERT INTO harness_subagents (id, user_id, chat_id, task_id, source_key, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      subagent.id, userId, subagent.chatId ?? null, subagent.taskId ?? null, key, JSON.stringify(subagent), now,
    );
    subagentTranscriptStore.replaceForUserInTransaction(db, subagent.id, userId, { messages: [], toolCalls: [], logs: [] });
  })();
  return subagent;
}

export function updateSubagent(subagent: Subagent, updates: Partial<Pick<Subagent, "activity" | "coverage" | "observation" | "error" | "unfinishedMessageIds">>): Subagent {
  const userId = requireResourcePersistenceUserId("subagent", subagent.id);
  const next = SubagentSchema.parse({ ...subagent, ...updates, updatedAt: new Date().toISOString() });
  const result = getDatabase().query("UPDATE harness_subagents SET record_json = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(next), subagent.id, userId);
  if (!result.changes) throw new DomainError("harness_session_not_found", "The saved subagent is unavailable.");
  return next;
}

export function getSubagentLog(id: string, logId: string): TaskLogEntry | null {
  const userId = requireResourcePersistenceUserId("subagent", id);
  const row = getDatabase().query<{ payload: string }, [string, string, string]>(
    "SELECT payload FROM subagent_transcript_entries WHERE subagent_id = ? AND user_id = ? AND entry_id = ?",
  ).get(id, userId, `log:${logId}`);
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.payload);
    if (!isTaskLogEntry(value)) throw new Error("Invalid transcript log");
    return value;
  } catch (cause) {
    throw new DomainError("harness_event_gap", "A saved subagent log is invalid.", { cause });
  }
}

export function writeSubagentEntry(subagent: Subagent, entry: TranscriptEntryUpsert): void {
  const userId = requireResourcePersistenceUserId("subagent", subagent.id);
  const db = getDatabase();
  db.transaction(() => {
    const meta = subagentTranscriptStore.getMetaForUser(subagent.id, userId);
    if (!meta) throw new DomainError("harness_event_gap", "Subagent transcript metadata is unavailable.");
    const exists = db.query("SELECT 1 FROM subagent_transcript_entries WHERE subagent_id = ? AND user_id = ? AND entry_id = ?")
      .get(subagent.id, userId, `${entry.kind}:${entry.id}`);
    subagentTranscriptStore.applyChangeSetInTransaction(db, subagent.id, userId, {
      upserts: [entry], deletes: [], entryCount: meta.entryCount + (exists ? 0 : 1),
    });
    updateSubagent(subagent, { unfinishedMessageIds: subagent.unfinishedMessageIds });
  })();
}

const ListCursorSchema = z.object({
  userId: z.string(), kind: z.enum(["chat", "task"]), parentId: z.string(),
  createdAt: z.iso.datetime(), id: z.string().uuid(),
});

export function listSubagents(context: SubagentContext, before?: string): SubagentList {
  const userId = requireResourcePersistenceUserId(context.kind, context.id);
  let cursor: z.infer<typeof ListCursorSchema> | undefined;
  if (before) {
    try {
      cursor = ListCursorSchema.parse(JSON.parse(Buffer.from(before, "base64url").toString("utf8")));
      if (cursor.userId !== userId || cursor.kind !== context.kind || cursor.parentId !== context.id) {
        throw new Error("Cursor scope mismatch");
      }
    } catch (cause) {
      throw new DomainError("transcript_cursor_invalid", "The subagent list cursor is invalid.", { cause });
    }
  }
  const column = context.kind === "chat" ? "chat_id" : "task_id";
  const rows = getDatabase().query<SubagentRow, Array<string | number>>(
    `SELECT record_json FROM harness_subagents WHERE user_id = ? AND ${column} = ?
      ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(userId, context.id, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), TRANSCRIPT_PAGE_SIZE + 1);
  const items = rows.slice(0, TRANSCRIPT_PAGE_SIZE).map(decode);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > TRANSCRIPT_PAGE_SIZE && last ? {
      nextCursor: Buffer.from(JSON.stringify({
        userId, kind: context.kind, parentId: context.id, createdAt: last.createdAt, id: last.id,
      })).toString("base64url"),
    } : {}),
  };
}
