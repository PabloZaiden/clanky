/**
 * Replays only persisted content into an isolated translator through log.synced.
 */
import type { OpenCodeClient } from "@opencode/client";
import type { HarnessHistoryEvent } from "@/shared/harness-history";
import type { HarnessEventScope } from "@/shared/harness-events";
import { NativeSessionHistory } from "../native-session-history";
import { HarnessError } from "../harness-errors";
import { OpenCodeEventTranslator } from "./event-translator";

export async function* readOpenCodeSessionHistory(client: OpenCodeClient, sessionId: string): AsyncGenerator<HarnessHistoryEvent[]> {
  const history = new NativeSessionHistory();
  const translator = new OpenCodeEventTranslator();
  const scope: HarnessEventScope = { kind: "principal", native: { adapter: "opencode2", conversationId: sessionId } };
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
