import { isChatTerminalStatus, type Chat } from "@/shared";
import { mergeToolCallRecords } from "@/shared/tool-call";

type ChatSnapshotKind = "full" | "summary";

const BUSY_CHAT_STATUSES = new Set<Chat["state"]["status"]>([
  "starting",
  "streaming",
  "interrupting",
  "reconnecting",
]);

export function applyChatStatusEvent(
  current: Chat,
  status: Chat["state"]["status"],
  timestamp: string,
): Chat {
  return {
    ...current,
    state: {
      ...current.state,
      status,
      lastActivityAt: timestamp,
      ...(isChatTerminalStatus(status)
        ? {
            activeMessageId: undefined,
            interruptRequested: false,
          }
        : {}),
    },
  };
}

function toTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function mergeChatSnapshotByKind(current: Chat, incoming: Chat, kind: ChatSnapshotKind): Chat {
  if (
    current.config.id !== incoming.config.id
    || current.state.id !== incoming.state.id
  ) {
    return incoming;
  }

  const currentActivityAt = toTimestamp(current.state.lastActivityAt);
  const incomingActivityAt = toTimestamp(incoming.state.lastActivityAt);
  const incomingActivityIsNotNewer = incomingActivityAt === null
    || (currentActivityAt !== null && incomingActivityAt <= currentActivityAt);
  const shouldPreserveCurrentTerminalState = isChatTerminalStatus(current.state.status)
    && BUSY_CHAT_STATUSES.has(incoming.state.status)
    && incomingActivityIsNotNewer;

  if (
    (
      currentActivityAt !== null
      && incomingActivityAt !== null
      && incomingActivityAt < currentActivityAt
    )
    || shouldPreserveCurrentTerminalState
  ) {
    return {
      ...incoming,
      config: {
        ...current.config,
        ...incoming.config,
      },
      state: current.state,
    };
  }

  return {
    ...incoming,
    config: {
      ...current.config,
      ...incoming.config,
    },
    state: {
      ...incoming.state,
      messages: kind === "summary" && incoming.state.messages.length === 0
        ? current.state.messages
        : incoming.state.messages,
      logs: kind === "summary" && incoming.state.logs.length === 0
        ? current.state.logs
        : incoming.state.logs,
      toolCalls: incoming.state.toolCalls.length > 0
        ? mergeToolCallRecords(current.state.toolCalls, incoming.state.toolCalls)
        : kind === "summary"
          ? current.state.toolCalls
          : incoming.state.toolCalls,
    },
  };
}

export function mergeChatSnapshot(current: Chat, incoming: Chat): Chat {
  return mergeChatSnapshotByKind(current, incoming, "full");
}

export function mergeChatSummarySnapshot(current: Chat, incoming: Chat): Chat {
  return mergeChatSnapshotByKind(current, incoming, "summary");
}

export function getStreamingActivityStatus(status: Chat["state"]["status"]): Chat["state"]["status"] {
  return status === "starting" ? "streaming" : status;
}
