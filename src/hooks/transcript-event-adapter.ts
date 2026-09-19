import type {
  AgentEvent,
  ChatEvent,
  TaskEvent,
  TranscriptStreamEvent,
} from "@/shared";
import { shouldIncludeConversationTranscriptLog } from "@/shared";

export function toTranscriptStreamEvent(
  event: AgentEvent | ChatEvent | TaskEvent,
): TranscriptStreamEvent | null {
  switch (event.type) {
    case "chat.message":
    case "agent.run.message":
    case "task.message":
      return { type: "transcript.message", message: event.message };
    case "chat.message.delta":
    case "agent.run.message.delta":
    case "task.message.delta":
      return {
        type: "transcript.message.delta",
        messageId: event.messageId,
        role: event.role,
        delta: event.delta,
        baseLength: event.baseLength,
        messageTimestamp: event.messageTimestamp,
      };
    case "chat.tool_call":
    case "agent.run.tool_call":
    case "task.tool_call":
      return { type: "transcript.tool", tool: event.tool };
    case "chat.tool_call.extra":
    case "agent.run.tool_call.extra":
    case "task.tool_call.extra":
      return {
        type: "transcript.tool.extra",
        toolId: event.toolId,
        extra: event.extra,
      };
    case "chat.log":
      return shouldIncludeConversationTranscriptLog(event.log)
        ? { type: "transcript.log", log: event.log }
        : null;
    case "agent.run.log":
      return { type: "transcript.log", log: event.log };
    case "task.log":
      {
        const log = {
          id: event.id,
          level: event.level,
          message: event.message,
          details: event.details,
          timestamp: event.timestamp,
        };
        return shouldIncludeConversationTranscriptLog(log)
          ? { type: "transcript.log", log }
          : null;
      }
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
    case "agent.run.log.delta":
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
    case "task.log.delta":
      if (!shouldIncludeConversationTranscriptLog({
        id: event.id,
        level: event.level,
        message: event.message,
        details: { logKind: event.logKind },
        timestamp: event.logTimestamp,
      })) {
        return null;
      }
      return {
        type: "transcript.log.delta",
        logId: event.id,
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
