/**
 * Atomic projection updates independent of transcript and input-ledger writes.
 */

import type { HarnessConversationBinding, HarnessConversationState } from "@/shared/harness-control";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";
import { parseStoredHarnessBinding, parseStoredHarnessState } from "./harness-binding";
import { HarnessConversationStateSchema } from "@/contracts/schemas/harness";
import { HarnessError } from "../backends/harness-errors";

export interface HarnessContext {
  kind: "chat" | "task";
  id: string;
}

export function mergeHarnessProjection(
  context: HarnessContext,
  binding: HarnessConversationBinding,
  projection: Pick<HarnessConversationState, "activity" | "cleanup" | "gitSafety" | "gitOutcome" | "capabilities">,
): boolean {
  const parsed = HarnessConversationStateSchema.safeParse(projection);
  if (!parsed.success) {
    throw new HarnessError("harness_request_failed", "The native activity projection is invalid.", {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) },
    });
  }
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const table = context.kind === "chat" ? "chats" : "tasks";
  return db.transaction(() => {
    const row = db.query<{ session_binding_json: string | null; harness_state_json: string | null }, [string, string]>(
      `SELECT session_binding_json, harness_state_json FROM ${table} WHERE id = ? AND user_id = ?`,
    ).get(context.id, userId);
    if (!row) return false;
    const current = parseStoredHarnessBinding(row.session_binding_json, context.id);
    if (!current || current.nativeId !== binding.nativeId || current.adapter !== binding.adapter || current.ownerId !== binding.ownerId || current.contextId !== binding.contextId) return false;
    const state = parseStoredHarnessState(row.harness_state_json, context.id);
    db.query(`UPDATE ${table} SET harness_state_json = ? WHERE id = ? AND user_id = ?`)
      .run(JSON.stringify({ ...state, ...projection }), context.id, userId);
    return true;
  })();
}
