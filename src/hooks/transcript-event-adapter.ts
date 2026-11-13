import type {
  TranscriptContentEvent,
  TranscriptStreamEvent,
} from "@/shared";
import { shouldIncludeConversationTranscriptLog } from "@/shared";

export function toTranscriptStreamEvent(
  event: TranscriptContentEvent,
): TranscriptStreamEvent | null {
  switch (event.type) {
    case "subagent.transcript":
      return event.event;
    case "chat.message":
    case "automation.run.message":
      return { type: "transcript.message", message: event.message };
    case "chat.message.delta":
    case "automation.run.message.delta":
      return {
        type: "transcript.message.delta",
        messageId: event.messageId,
        role: event.role,
        delta: event.delta,
        baseLength: event.baseLength,
        messageTimestamp: event.messageTimestamp,
      };
    case "chat.tool_call":
    case "automation.run.tool_call":
      return { type: "transcript.tool", tool: event.tool };
    case "chat.log":
      return shouldIncludeConversationTranscriptLog(event.log)
        ? { type: "transcript.log", log: event.log }
        : null;
    case "automation.run.log":
      return { type: "transcript.log", log: event.log };
    case "chat.log.delta":
      if (!shouldIncludeConversationTranscriptLog({
        id: event.logId,
        level: event.level,
        message: event.message,
        details: { logKind: event.logKind },
        timestamp: event.logTimestamp,
      })) {
        return null;
      }
      return {
        type: "transcript.log.delta",
        logId: event.logId,
        level: event.level,
        message: event.message,
        logKind: event.logKind,
        delta: event.delta,
        baseLength: event.baseLength,
        logTimestamp: event.logTimestamp,
      };
    case "automation.run.log.delta":
      return {
        type: "transcript.log.delta",
        logId: event.logId,
        level: event.level,
        message: event.message,
        logKind: event.logKind,
        delta: event.delta,
        baseLength: event.baseLength,
        logTimestamp: event.logTimestamp,
      };
    default:
      return null;
  }
}
