import type { Chat } from "../types";
import { mergeToolCallRecords } from "../types/tool-call";

type ChatSnapshotKind = "full" | "summary";

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

  if (
    currentActivityAt !== null
    && incomingActivityAt !== null
    && incomingActivityAt < currentActivityAt
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
