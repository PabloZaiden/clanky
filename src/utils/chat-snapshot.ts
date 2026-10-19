import type { Chat } from "@/shared";
import { mergeToolCallRecords } from "@/shared/tool-call";

type ChatSnapshotKind = "full" | "summary";

function mergeChatSnapshotByKind(current: Chat, incoming: Chat, kind: ChatSnapshotKind): Chat {
  if (
    current.config.id !== incoming.config.id
    || current.state.id !== incoming.state.id
  ) {
    return incoming;
  }

  if (incoming.state.revision < current.state.revision) {
    return current;
  }

  return {
    ...incoming,
    config: {
      ...current.config,
      ...incoming.config,
    },
    state: {
      ...incoming.state,
      lastActivityAt: current.state.lastActivityAt
        && (!incoming.state.lastActivityAt || current.state.lastActivityAt > incoming.state.lastActivityAt)
        ? current.state.lastActivityAt
        : incoming.state.lastActivityAt,
      lastUserMessageAt: current.state.lastUserMessageAt
        && (!incoming.state.lastUserMessageAt || current.state.lastUserMessageAt > incoming.state.lastUserMessageAt)
        ? current.state.lastUserMessageAt
        : incoming.state.lastUserMessageAt,
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

export function reuseChatSnapshotPresentation(current: Chat, incoming: Chat): Chat {
  if (current === incoming) return current;
  const presentation = (chat: Chat) => ({
    config: chat.config,
    state: { ...chat.state, lastActivityAt: undefined, revision: undefined },
  });
  if (
    !hasSameChatPresentation(current, incoming)
    && JSON.stringify(presentation(current)) !== JSON.stringify(presentation(incoming))
  ) {
    return incoming;
  }
  return current.state.lastActivityAt === incoming.state.lastActivityAt
    && current.state.revision === incoming.state.revision
    ? current
    : {
        ...current,
        state: {
          ...current.state,
          lastActivityAt: incoming.state.lastActivityAt,
          revision: incoming.state.revision,
        },
      };
}

export function hasSameChatPresentation(current: Chat | null, next: Chat | null): boolean {
  if (current === next) return true;
  if (!current || !next || current.config !== next.config) return false;
  const keys = new Set([...Object.keys(current.state), ...Object.keys(next.state)]);
  for (const key of keys) {
    if (key === "lastActivityAt" || key === "revision") continue;
    const field = key as keyof Chat["state"];
    if (current.state[field] !== next.state[field]) return false;
  }
  return true;
}
