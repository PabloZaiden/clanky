/**
 * Streams durable principal content in native order without activating work.
 */
import type { CopilotSession } from "@github/copilot-sdk";
import type { HarnessHistoryEvent } from "@/shared/harness-history";
import { HarnessError } from "../harness-errors";
import { NativeSessionHistory } from "../native-session-history";
import { CopilotEventTranslator } from "./event-translator";
import type { HarnessEvent } from "@/shared/harness-events";
import { NativeSubagentHistory, type NativeHistoryCollector } from "../native-subagent-history";

export async function* readCopilotSessionHistory(session: CopilotSession): AsyncGenerator<HarnessHistoryEvent[]> {
  yield* readCopilotHistory(session, new NativeSessionHistory());
}

export async function* readCopilotSubagentHistory(session: CopilotSession, activityId: string): AsyncGenerator<HarnessEvent[]> {
  yield* readCopilotHistory(session, new NativeSubagentHistory(activityId), activityId);
}

async function* readCopilotHistory<TEvent extends HarnessEvent>(
  session: CopilotSession, history: NativeHistoryCollector<TEvent>, activityId?: string,
): AsyncGenerator<TEvent[]> {
  const translator = new CopilotEventTranslator(session.sessionId);
  const seen = new Set<string>();
  let started = false;
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 1000) throw new HarnessError("harness_event_gap", "Native history exceeds the pagination limit.");
    const result = await session.rpc.eventLog.read({
      cursor, direction: "forward", includeEphemeral: false, max: 200,
      ...(activityId ? { agentIds: [activityId] as [string] } : { agentScope: "primary" as const }),
      types: activityId
        ? ["session.start", "subagent.started", "user.message", "assistant.message", "assistant.reasoning", "tool.execution_start", "tool.execution_complete", "session.snapshot_rewind", "session.error"]
        : ["session.start", "assistant.message", "tool.execution_start", "tool.execution_complete", "session.snapshot_rewind", "session.error"],
    });
    if (result.cursorStatus !== "ok") throw new HarnessError("harness_event_gap", "The native history cursor expired.");
    for (const event of result.events) {
      history.observeNative(event);
      if (!started) {
        if (activityId
          ? event.type !== "subagent.started" || event.agentId !== activityId
          : event.type !== "session.start" || event.parentId !== null) {
          throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
        }
        started = true;
      }
      if (seen.has(event.id)) throw new HarnessError("harness_event_gap", "Native history pages overlap.");
      seen.add(event.id);
      if (event.type === "session.snapshot_rewind") {
        throw new HarnessError("harness_event_gap", "Rewound native history cannot be recovered completely.");
      }
      if (activityId && event.agentId && event.agentId !== activityId) {
        throw new HarnessError("harness_session_not_owned", "The native event log returned another child's content.");
      }
      for (const translated of translator.translate(activityId ? { ...event, agentId: activityId } : event)) history.append(translated);
      const events = history.takeEvents();
      if (events.length) yield events;
    }
    if (!result.hasMore) break;
    if (!result.cursor || result.cursor === cursor) throw new HarnessError("harness_event_gap", "Native history pagination made no progress.");
    cursor = result.cursor;
  }
  if (!started) throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
}
