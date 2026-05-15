import type { Chat } from "../types";
import { mergeToolCallRecords } from "../types/tool-call";

function toTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function mergeChatSnapshot(current: Chat, incoming: Chat): Chat {
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
      messages: incoming.state.messages.length > 0 ? incoming.state.messages : current.state.messages,
      logs: incoming.state.logs.length > 0 ? incoming.state.logs : current.state.logs,
      toolCalls: incoming.state.toolCalls.length > 0
        ? mergeToolCallRecords(current.state.toolCalls, incoming.state.toolCalls)
        : current.state.toolCalls,
    },
  };
}
