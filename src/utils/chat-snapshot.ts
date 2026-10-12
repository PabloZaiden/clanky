import { isChatTerminalStatus, type Chat } from "@/shared";
import { isQuestionOpen, type HarnessQuestionRequest } from "@/shared/harness-questions";
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
  const currentActivityAt = toTimestamp(current.state.lastActivityAt);
  const incomingActivityAt = toTimestamp(timestamp);
  if (
    currentActivityAt !== null
    && (incomingActivityAt === null || incomingActivityAt < currentActivityAt)
  ) {
    return current;
  }

  return {
    ...current,
    state: {
      ...current.state,
      status,
      lastActivityAt: timestamp,
      ...(status !== "starting"
        ? {
            startupStage: undefined,
          }
        : {}),
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

function getResolvedBlockingQuestionUpdates(
  current: Chat,
  incoming: Chat,
): Map<string, HarnessQuestionRequest> {
  const updates = new Map<string, HarnessQuestionRequest>();
  if (current.state.status !== "waiting") return updates;
  const incomingQuestions = new Map(
    (incoming.state.harness?.questions ?? []).map((request) => [request.requestId, request]),
  );
  for (const request of current.state.harness?.questions ?? []) {
    if (!request.blocking || !isQuestionOpen(request)) continue;
    const resolved = incomingQuestions.get(request.requestId);
    if (resolved && !isQuestionOpen(resolved)) updates.set(request.requestId, resolved);
  }
  return updates;
}

function mergeResolvedQuestion(
  current: HarnessQuestionRequest,
  resolved: HarnessQuestionRequest,
): HarnessQuestionRequest {
  const transcript = current.transcript && resolved.transcript
    ? {
        ...resolved.transcript,
        ...current.transcript,
        answerTimestamp: resolved.transcript.answerTimestamp ?? current.transcript.answerTimestamp,
      }
    : current.transcript ?? resolved.transcript;
  return {
    ...current,
    status: resolved.status,
    answers: resolved.answers ?? current.answers,
    resolvedAt: resolved.resolvedAt ?? current.resolvedAt,
    error: resolved.error,
    ...(transcript ? { transcript } : {}),
  };
}

function mergeResolvedBlockingQuestionSnapshot(
  current: Chat,
  incoming: Chat,
  questionUpdates: Map<string, HarnessQuestionRequest>,
): Chat {
  const questions = (current.state.harness?.questions ?? []).map((request) => {
    const resolved = questionUpdates.get(request.requestId);
    return resolved ? mergeResolvedQuestion(request, resolved) : request;
  });
  const hasPendingBlockingQuestion = questions.some(
    (request) => request.blocking && isQuestionOpen(request),
  );
  const hasPendingPermissionRequest = (current.state.pendingPermissionRequests ?? [])
    .some((request) => request.status === "pending");

  return {
    ...current,
    config: {
      ...current.config,
      ...incoming.config,
    },
    state: {
      ...current.state,
      status: hasPendingBlockingQuestion || hasPendingPermissionRequest
        ? current.state.status
        : incoming.state.status,
      lastActivityAt: current.state.lastActivityAt,
      harness: {
        ...current.state.harness,
        questions,
      },
    },
  };
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
  const incomingActivityIsOlder = currentActivityAt !== null
    && incomingActivityAt !== null
    && incomingActivityAt < currentActivityAt;
  const questionUpdates = incomingActivityIsOlder
    ? getResolvedBlockingQuestionUpdates(current, incoming)
    : new Map<string, HarnessQuestionRequest>();
  const shouldPreserveCurrentTerminalState = isChatTerminalStatus(current.state.status)
    && BUSY_CHAT_STATUSES.has(incoming.state.status)
    && incomingActivityIsNotNewer;

  if (
    (incomingActivityIsOlder && questionUpdates.size === 0)
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

  if (questionUpdates.size > 0) {
    return mergeResolvedBlockingQuestionSnapshot(current, incoming, questionUpdates);
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

export function reuseChatSnapshotPresentation(current: Chat, incoming: Chat): Chat {
  if (current === incoming) return current;
  const withoutActivity = (chat: Chat) => ({
    config: chat.config,
    state: { ...chat.state, lastActivityAt: undefined },
  });
  if (
    !hasSameChatPresentation(current, incoming)
    && JSON.stringify(withoutActivity(current)) !== JSON.stringify(withoutActivity(incoming))
  ) {
    return incoming;
  }
  return current.state.lastActivityAt === incoming.state.lastActivityAt
    ? current
    : {
        ...current,
        state: { ...current.state, lastActivityAt: incoming.state.lastActivityAt },
      };
}

export function hasSameChatPresentation(current: Chat | null, next: Chat | null): boolean {
  if (current === next) return true;
  if (!current || !next || current.config !== next.config) return false;
  const keys = new Set([...Object.keys(current.state), ...Object.keys(next.state)]);
  for (const key of keys) {
    if (key === "lastActivityAt") continue;
    const field = key as keyof Chat["state"];
    if (current.state[field] !== next.state[field]) return false;
  }
  return true;
}

export function getStreamingActivityStatus(status: Chat["state"]["status"]): Chat["state"]["status"] {
  return status === "starting" ? "streaming" : status;
}
