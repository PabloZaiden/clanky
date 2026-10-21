/**
 * Canonical session high-water marks and independently persisted entity totals.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { TOKEN_USAGE_FIELDS, type HarnessUsageSnapshot, type TokenCounts, type TokenUsageSummary } from "@/shared/harness-usage";
import { HarnessUsageSnapshotSchema, TokenUsageSummarySchema } from "@/contracts/schemas/harness-usage";
import { HarnessError } from "../backends/harness-errors";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";
import { parseStoredHarnessBinding } from "./harness-binding";
import { invalidateChatMetadata } from "./chats/metadata-cache";
import type { HarnessContext } from "./harness-state";
import { requireMatchingHarnessBindings } from "../backends/harness-binding";

const log = createLogger("persistence:harness-usage");

interface UsageRow {
  chat_id: string | null;
  task_id: string | null;
  snapshot_json: string;
  status: "current" | "stale";
}

export interface UsageChange {
  contexts: HarnessContext[];
  runs: Array<{ id: string; agentId: string }>;
}

export function parseStoredTokenUsage(raw: unknown, contextId: string): TokenUsageSummary | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    if (typeof raw !== "string") throw new Error("Stored token usage must be JSON.");
    return TokenUsageSummarySchema.parse(JSON.parse(raw));
  } catch (error) {
    log.warn("Stored token usage is invalid", { contextId, error: String(error) });
    return undefined;
  }
}

function readSnapshot(raw: string): HarnessUsageSnapshot {
  try {
    return HarnessUsageSnapshotSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new HarnessError("harness_request_failed", "Persisted token accounting is invalid.", { cause: error });
  }
}

function mergeSnapshot(previous: HarnessUsageSnapshot | undefined, next: HarnessUsageSnapshot): HarnessUsageSnapshot {
  const contributors = new Map(previous?.contributors.map((entry) => [entry.id, { ...entry.tokens }]));
  for (const entry of next.contributors) {
    const tokens = contributors.get(entry.id) ?? {};
    for (const field of TOKEN_USAGE_FIELDS) {
      const value = entry.tokens[field];
      if (value !== undefined) tokens[field] = Math.max(tokens[field] ?? 0, value);
    }
    contributors.set(entry.id, tokens);
  }
  if (contributors.size > 1000) throw new HarnessError("harness_request_failed", "Token accounting exceeded its contributor limit.");
  return { ...next, contributors: [...contributors].map(([id, tokens]) => ({ id, tokens })) };
}

function summarize(rows: UsageRow[]): TokenUsageSummary {
  const tokens: TokenCounts = {};
  let coverage: TokenUsageSummary["coverage"] = "complete";
  let status: TokenUsageSummary["status"] = "current";
  let observedAt = new Date(0).toISOString();
  for (const row of rows) {
    const snapshot = readSnapshot(row.snapshot_json);
    if (snapshot.coverage === "partial") coverage = "partial";
    if (row.status === "stale") status = "stale";
    if (snapshot.observedAt > observedAt) observedAt = snapshot.observedAt;
    for (const contributor of snapshot.contributors) {
      if (contributor.tokens.outputTokens === undefined) coverage = "partial";
      for (const field of TOKEN_USAGE_FIELDS) {
        const value = contributor.tokens[field];
        if (value !== undefined) tokens[field] = (tokens[field] ?? 0) + value;
      }
    }
  }
  return TokenUsageSummarySchema.parse({ ...tokens, observedAt, coverage, status });
}

function sourceKey(binding: HarnessConversationBinding): string {
  return JSON.stringify([binding.adapter, binding.executionHost?.targetKey ?? "local", binding.nativeId]);
}

function updateSummaries(context: HarnessContext, row: Pick<UsageRow, "chat_id" | "task_id">): UsageChange {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const contexts: HarnessContext[] = [context];
  const runs: UsageChange["runs"] = [];
  if (row.chat_id) {
    const summary = summarize(db.query<UsageRow, [string, string]>(
      "SELECT * FROM harness_usage WHERE user_id = ? AND chat_id = ?",
    ).all(userId, row.chat_id));
    const json = JSON.stringify(summary);
    invalidateChatMetadata(db, userId, row.chat_id);
    db.query("UPDATE chats SET usage_json = ?, state_revision = state_revision + 1 WHERE id = ? AND user_id = ?")
      .run(json, row.chat_id, userId);
    runs.push(...db.query<{ id: string; agentId: string }, [string, string]>(
      "SELECT id, agent_id AS agentId FROM agent_runs WHERE chat_id = ? AND user_id = ?",
    ).all(row.chat_id, userId));
    db.query("UPDATE agent_runs SET usage_json = ? WHERE chat_id = ? AND user_id = ?").run(json, row.chat_id, userId);
  }
  if (row.task_id) {
    const summary = summarize(db.query<UsageRow, [string, string]>(
      "SELECT * FROM harness_usage WHERE user_id = ? AND task_id = ?",
    ).all(userId, row.task_id));
    db.query("UPDATE tasks SET usage_json = ? WHERE id = ? AND user_id = ?")
      .run(JSON.stringify(summary), row.task_id, userId);
    if (context.kind !== "task") contexts.push({ kind: "task", id: row.task_id });
  }
  return { contexts, runs };
}

export function saveHarnessUsage(
  context: HarnessContext,
  binding: HarnessConversationBinding,
  snapshot: HarnessUsageSnapshot,
): UsageChange | undefined {
  const next = HarnessUsageSnapshotSchema.parse(snapshot);
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  return db.transaction(() => {
    const owner = context.kind === "chat"
      ? db.query<{ session_binding_json: string | null; task_id: string | null }, [string, string]>(
          "SELECT session_binding_json, task_id FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        ).get(context.id, userId)
      : db.query<{ session_binding_json: string | null; task_id: string }, [string, string]>(
          "SELECT session_binding_json, id AS task_id FROM tasks WHERE id = ? AND user_id = ?",
        ).get(context.id, userId);
    const current = owner ? parseStoredHarnessBinding(owner.session_binding_json, context.id) : undefined;
    if (!current || current.ownerId !== userId || current.contextId !== context.id
      || current.adapter !== binding.adapter || current.nativeId !== binding.nativeId) return undefined;
    requireMatchingHarnessBindings(current, binding);
    const key = sourceKey(binding);
    const previous = db.query<UsageRow, [string, string]>(
      "SELECT * FROM harness_usage WHERE user_id = ? AND source_key = ?",
    ).get(userId, key);
    const chatId = context.kind === "chat" ? context.id : null;
    const taskId = owner!.task_id;
    if (previous && (previous.chat_id !== chatId || previous.task_id !== taskId)) {
      throw new HarnessError("harness_session_not_owned", "Token accounting belongs to another conversation.");
    }
    const merged = mergeSnapshot(previous ? readSnapshot(previous.snapshot_json) : undefined, next);
    db.query(`INSERT INTO harness_usage (user_id, source_key, chat_id, task_id, snapshot_json, status)
      VALUES (?, ?, ?, ?, ?, 'current')
      ON CONFLICT(user_id, source_key) DO UPDATE SET snapshot_json = excluded.snapshot_json, status = excluded.status`)
      .run(userId, key, chatId, taskId, JSON.stringify(merged));
    return updateSummaries(context, { chat_id: chatId, task_id: taskId });
  })();
}

export function markHarnessUsageStale(context: HarnessContext, binding: HarnessConversationBinding): UsageChange | undefined {
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  return db.transaction(() => {
    const row = db.query<UsageRow, [string, string]>(
      "SELECT * FROM harness_usage WHERE user_id = ? AND source_key = ?",
    ).get(userId, sourceKey(binding));
    if (!row || (context.kind === "chat" ? row.chat_id !== context.id : row.chat_id !== null || row.task_id !== context.id)) return undefined;
    db.query("UPDATE harness_usage SET status = 'stale' WHERE user_id = ? AND source_key = ?")
      .run(userId, sourceKey(binding));
    return updateSummaries(context, row);
  })();
}
