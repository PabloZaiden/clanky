/**
 * Projects public app-server history without touching a live translator.
 */
import type { HarnessHistoryEvent } from "@/shared/harness-history";
import type { HarnessEvent, HarnessEventScope } from "@/shared/harness-events";
import type { Turn } from "./generated/v2/Turn";
import type { CodexRpcSession } from "./rpc-session";
import { NativeSessionHistory } from "../native-session-history";
import { HarnessError } from "../harness-errors";
import { CodexEventTranslator } from "./event-translator";
import { NativeSubagentHistory, type NativeHistoryCollector } from "../native-subagent-history";

async function* projectTurn<TEvent extends HarnessEvent>(options: {
  history: NativeHistoryCollector<TEvent>;
  rpc: CodexRpcSession;
  threadId: string;
  turn: Turn;
  activityId?: string;
}): AsyncGenerator<TEvent[]> {
  const { history, rpc, threadId, turn } = options;
  history.observeNative({ ...turn, items: undefined });
  const translator = new CodexEventTranslator();
  const native = { adapter: "codex" as const, conversationId: threadId, turnId: turn.id };
  const scope: HarnessEventScope = options.activityId
    ? { kind: "child", activityId: options.activityId, native }
    : { kind: "principal", native };
  const nativeTimestamp = turn.completedAt ?? turn.startedAt;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new HarnessError("harness_event_gap", "Native item history exceeds the pagination limit.");
    const result = await rpc.request("thread/items/list", {
      threadId, turnId: turn.id, cursor, limit: 100, sortDirection: "asc",
    });
    for (const entry of result.data) {
      if (entry.turnId !== turn.id) throw new HarnessError("harness_event_gap", "Native item history belongs to a different turn.");
      const item = entry.item;
      history.observeNative(item);
      if (seen.has(item.id)) throw new HarnessError("harness_event_gap", "Native item history pages overlap.");
      seen.add(item.id);
      if (item.type === "contextCompaction") {
        throw new HarnessError("harness_event_gap", "Compacted native history cannot prove complete recovery.");
      }
      if ("status" in item && item.status === "inProgress") continue;
      if (turn.status === "inProgress" && item.type === "agentMessage" && entry.completedAtMs == null) {
        throw new HarnessError("harness_event_gap", "An active native message has no durable completion boundary.");
      }
      if (turn.status === "inProgress" && !("status" in item) && entry.completedAtMs == null) continue;
      const nativeTime = entry.completedAtMs ?? entry.startedAtMs
        ?? (nativeTimestamp === null ? undefined : nativeTimestamp * 1000);
      const timestamp = nativeTime === undefined ? undefined : new Date(nativeTime).toISOString();
      for (const event of translator.translateHistoryItem(item, scope)) history.append({ ...event, timestamp });
      const events = history.takeEvents();
      if (events.length) yield events;
    }
    if (!result.nextCursor) break;
    if (cursor === result.nextCursor) throw new HarnessError("harness_event_gap", "Native item pagination made no progress.");
    cursor = result.nextCursor;
  }
}

export async function* readCodexSessionHistory(rpc: CodexRpcSession, threadId: string): AsyncGenerator<HarnessHistoryEvent[]> {
  yield* readCodexHistory(rpc, threadId, new NativeSessionHistory());
}

export async function* readCodexSubagentHistory(rpc: CodexRpcSession, threadId: string): AsyncGenerator<HarnessEvent[]> {
  yield* readCodexHistory(rpc, threadId, new NativeSubagentHistory(threadId), threadId);
}

async function* readCodexHistory<TEvent extends HarnessEvent>(
  rpc: CodexRpcSession, threadId: string, history: NativeHistoryCollector<TEvent>, activityId?: string,
): AsyncGenerator<TEvent[]> {
  const initial = await rpc.request("thread/read", { threadId, includeTurns: false });
  if (initial.thread.id !== threadId) throw new HarnessError("harness_session_not_owned", "Native history belongs to a different conversation.");
  if (initial.thread.historyMode === "paginated" || initial.thread.historyMode === "legacy") {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new HarnessError("harness_event_gap", "Native history exceeds the pagination limit.");
      const result = await rpc.request("thread/turns/list", {
        threadId, cursor, limit: 50, sortDirection: "asc", itemsView: "notLoaded",
      });
      for (const turn of result.data) {
        if (seen.has(turn.id)) throw new HarnessError("harness_event_gap", "Native history pages overlap.");
        seen.add(turn.id);
        yield* projectTurn({ history, rpc, threadId, turn, activityId });
      }
      if (!result.nextCursor) break;
      if (cursor === result.nextCursor) throw new HarnessError("harness_event_gap", "Native history pagination made no progress.");
      cursor = result.nextCursor;
    }
  } else {
    throw new HarnessError("harness_event_gap", "The native runtime does not expose a complete history contract.");
  }
}

export async function isCodexSessionProcessing(rpc: CodexRpcSession, threadId: string): Promise<boolean> {
  const current = await rpc.request("thread/read", { threadId, includeTurns: false });
  if (current.thread.id !== threadId) throw new HarnessError("harness_session_not_owned", "Native history belongs to a different conversation.");
  if (current.thread.status.type !== "active" && current.thread.status.type !== "idle") {
    throw new HarnessError("harness_event_gap", "The current native execution state is unavailable.");
  }
  return current.thread.status.type === "active";
}
