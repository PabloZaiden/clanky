/**
 * Replays only persisted content into an isolated translator through log.synced.
 */
import type { OpenCodeClient } from "@opencode/client";
import type { HarnessHistoryEvent } from "@/shared/harness-history";
import type { HarnessEvent, HarnessEventScope } from "@/shared/harness-events";
import { NativeSessionHistory } from "../native-session-history";
import { HarnessError } from "../harness-errors";
import { OpenCodeEventTranslator } from "./event-translator";
import { NativeSubagentHistory, type NativeHistoryCollector } from "../native-subagent-history";

export async function* readOpenCodeSessionHistory(client: OpenCodeClient, sessionId: string): AsyncGenerator<HarnessHistoryEvent[]> {
  yield* readOpenCodeHistory(client, sessionId, new NativeSessionHistory());
}

export async function* readOpenCodeSubagentHistory(client: OpenCodeClient, sessionId: string): AsyncGenerator<HarnessEvent[]> {
  yield* readOpenCodeHistory(client, sessionId, new NativeSubagentHistory(sessionId), sessionId);
}

async function* readOpenCodeHistory<TEvent extends HarnessEvent>(
  client: OpenCodeClient, sessionId: string, history: NativeHistoryCollector<TEvent>, activityId?: string,
): AsyncGenerator<TEvent[]> {
  const translator = new OpenCodeEventTranslator();
  const native = { adapter: "opencode2" as const, conversationId: sessionId };
  const scope: HarnessEventScope = activityId ? { kind: "child", activityId, native } : { kind: "principal", native };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let synced = false;
  let started = false;
  try {
    for await (const event of client.session.log({ sessionID: sessionId, follow: false }, { signal: controller.signal })) {
      if (event.type === "log.synced") {
        if (event.aggregateID !== sessionId || event.seq !== translator.sequence || !started) {
          throw new HarnessError("harness_event_gap", "The native history synchronization boundary is incomplete.");
        }
        synced = true;
        break;
      }
      history.observeNative(event);
      if (event.durable.aggregateID !== sessionId || event.data.sessionID !== sessionId) {
        throw new HarnessError("harness_session_not_owned", "Native history belongs to a different conversation.");
      }
      if (!started) {
        if (event.type !== "session.created") throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
        started = true;
      }
      if (event.type === "session.revert.committed" || event.type === "session.message.content.updated" || event.type === "session.forked") {
        throw new HarnessError("harness_event_gap", "Rewritten native history cannot be recovered completely.");
      }
      for (const translated of translator.translate(event, scope)) history.append(translated);
      const events = history.takeEvents();
      if (events.length) yield events;
    }
    if (!synced) throw new HarnessError("harness_event_gap", "The native history stream ended before synchronization.");
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("harness_event_gap", "Native history could not be recovered.", { cause: error });
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
