/**
 * Streams durable principal content in native order without activating work.
 */
import type { CopilotSession } from "@github/copilot-sdk";
import type { HarnessHistoryEvent } from "@/shared/harness-history";
import { HarnessError } from "../harness-errors";
import { NativeSessionHistory } from "../native-session-history";
import { CopilotEventTranslator } from "./event-translator";

export async function* readCopilotSessionHistory(session: CopilotSession): AsyncGenerator<HarnessHistoryEvent[]> {
  const history = new NativeSessionHistory();
  const translator = new CopilotEventTranslator(session.sessionId);
  const seen = new Set<string>();
  let started = false;
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new HarnessError("harness_event_gap", "Native history exceeds the pagination limit.");
    const result = await session.rpc.eventLog.read({
      cursor, direction: "forward", includeEphemeral: false, max: 200, agentScope: "primary",
      types: ["session.start", "assistant.message", "tool.execution_start", "tool.execution_complete", "session.snapshot_rewind", "session.error"],
    });
    if (result.cursorStatus !== "ok") throw new HarnessError("harness_event_gap", "The native history cursor expired.");
    for (const event of result.events) {
      history.observeNative(event);
      if (!started) {
        if (event.type !== "session.start" || event.parentId !== null) {
          throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
        }
        started = true;
      }
      if (seen.has(event.id)) throw new HarnessError("harness_event_gap", "Native history pages overlap.");
      seen.add(event.id);
      if (event.type === "session.snapshot_rewind") {
        throw new HarnessError("harness_event_gap", "Rewound native history cannot be recovered completely.");
      }
      for (const translated of translator.translate(event)) history.append(translated);
      const events = history.takeEvents();
      if (events.length) yield events;
    }
    if (!result.hasMore) break;
    if (!result.cursor || result.cursor === cursor) throw new HarnessError("harness_event_gap", "Native history pagination made no progress.");
    cursor = result.cursor;
  }
  if (!started) throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
}
