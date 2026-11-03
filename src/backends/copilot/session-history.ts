/**
 * Streams durable principal content in native order without activating work.
 */
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { getBase64DecodedByteLength } from "@/shared/message-attachments";
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
  const assets = new Map<string, Extract<SessionEvent, { type: "session.binary_asset" }>["data"]>();
  const assetCursors = new Set<string>();
  let assetCursor: string | undefined;
  let assetsComplete = false;
  const readAsset = async (assetId: string) => {
    while (!assets.has(assetId) && !assetsComplete) {
      const page = await session.rpc.eventLog.read({
        cursor: assetCursor, direction: "forward", includeEphemeral: false,
        max: 200, agentScope: "all", types: ["session.binary_asset"],
      });
      if (page.cursorStatus !== "ok") throw new HarnessError("harness_event_gap", "The native binary history cursor expired.");
      for (const event of page.events) {
        if (event.type !== "session.binary_asset") {
          throw new HarnessError("harness_event_gap", "The native binary history returned an invalid event.");
        }
        if (seen.has(event.id)) throw new HarnessError("harness_event_gap", "Native binary history pages overlap.");
        seen.add(event.id);
        assets.set(event.data.assetId, event.data);
      }
      assetsComplete = !page.hasMore;
      if (!assetsComplete) {
        if (!page.cursor || assetCursors.has(page.cursor)) {
          throw new HarnessError("harness_event_gap", "Native binary history pagination made no progress.");
        }
        assetCursors.add(page.cursor);
      }
      assetCursor = page.cursor;
    }
    const asset = assets.get(assetId);
    if (!asset) throw new HarnessError("harness_event_gap", "A native image's persisted binary data is unavailable.");
    return asset;
  };
  let started = false;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const result = await session.rpc.eventLog.read({
      cursor, direction: "forward", includeEphemeral: false, max: 200,
      ...(activityId ? { agentIds: [activityId] as [string] } : { agentScope: "primary" as const }),
      types: activityId
        ? ["session.start", "subagent.started", "user.message", "assistant.message", "assistant.reasoning", "tool.execution_start", "tool.execution_complete", "session.snapshot_rewind", "session.error"]
        : ["session.start", "assistant.message", "tool.execution_start", "tool.execution_complete", "session.snapshot_rewind", "session.error"],
    });
    if (result.cursorStatus !== "ok") throw new HarnessError("harness_event_gap", "The native history cursor expired.");
    for (let event of result.events) {
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
      if (event.type === "tool.execution_complete" && event.data.result?.binaryResultsForLlm) {
        const binaries: typeof event.data.result.binaryResultsForLlm = [];
        for (const binary of event.data.result.binaryResultsForLlm) {
          if (!("assetId" in binary) || binary.type !== "image") {
            binaries.push(binary);
            continue;
          }
          const asset = await readAsset(binary.assetId);
          if (asset.type !== binary.type || asset.mimeType !== binary.mimeType
            || asset.byteLength !== binary.byteLength
            || getBase64DecodedByteLength(asset.data) !== binary.byteLength) {
            throw new HarnessError("harness_event_gap", "A native image does not match its persisted binary reference.");
          }
          const { assetId: _assetId, byteLength: _byteLength, ...metadata } = binary;
          binaries.push({ ...metadata, data: asset.data });
        }
        event = { ...event, data: { ...event.data, result: { ...event.data.result, binaryResultsForLlm: binaries } } };
      }
      for (const translated of translator.translate(activityId ? { ...event, agentId: activityId } : event)) history.append(translated);
      const events = history.takeEvents();
      if (events.length) yield events;
    }
    if (!result.hasMore) break;
    if (!result.cursor || cursors.has(result.cursor)) throw new HarnessError("harness_event_gap", "Native history pagination made no progress.");
    cursors.add(result.cursor);
    cursor = result.cursor;
  }
  if (!started) throw new HarnessError("harness_event_gap", "The beginning of native history is unavailable.");
}
