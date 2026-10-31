import { useCallback, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ChatSnapshot,
} from "@/shared";
import { useTranscriptResource } from "../../hooks";
import { useChatResourceState } from "../../hooks/chat-state-context";
import { apiRequest } from "../../lib/api-client";
import {
  hasSameChatPresentation,
  mergeChatSummarySnapshot,
  reuseChatSnapshotPresentation,
} from "../../utils/chat-snapshot";
import type { ChatLifecycleResult } from "./types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "waiting", "interrupting", "reconnecting"]);

export function getChatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeChatSnapshot(
  snapshot: ChatSnapshot,
): { resource: Chat; transcript: ChatSnapshot["transcript"] } {
  return {
    resource: {
      config: snapshot.config,
      state: {
        ...snapshot.state,
        messages: [],
        logs: [],
        toolCalls: [],
      },
    },
    transcript: snapshot.transcript,
  };
}

function mergeOperationalChatSnapshot(current: Chat | null, incoming: Chat): Chat {
  if (!current) {
    return incoming;
  }
  const merged = mergeChatSummarySnapshot(current, incoming);
  return reuseChatSnapshotPresentation(current, {
    ...merged,
    state: {
      ...merged.state,
      messages: [],
      logs: [],
      toolCalls: [],
    },
  });
}

export function useChatLifecycle(chatId: string): ChatLifecycleResult {
  const toast = useToast();
  const resourceState = useChatResourceState(chatId);
  const [isContinuingFromHistory, setIsContinuingFromHistory] = useState(false);
  const mountedChatIdRef = useRef(chatId);
  mountedChatIdRef.current = chatId;

  const transcriptResource = useTranscriptResource<Chat, ChatSnapshot>({
    resourceId: chatId,
    resourceLabel: "chat",
    stream: "chat",
    baseUrl: `/api/chats/${encodeURIComponent(chatId)}`,
    resourceState,
    decodeSnapshot: decodeChatSnapshot,
    mergeResource: mergeOperationalChatSnapshot,
    isResourcePresentationEqual: hasSameChatPresentation,
  });
  const {
    resource: chat,
    setResource: setChat,
    transcript,
    loading,
    loadingTranscript,
    error,
    notFound,
    refresh: refreshChat,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolDetails: loadToolCallDetails,
  } = transcriptResource;

  const applyChatSnapshot = useCallback((nextChat: Chat): void => {
    if (mountedChatIdRef.current !== chatId || nextChat.config.id !== chatId) {
      return;
    }
    setChat((current) => mergeOperationalChatSnapshot(current, {
      ...nextChat,
      state: {
        ...nextChat.state,
        messages: [],
        logs: [],
        toolCalls: [],
      },
    }));
  }, [chatId, setChat]);

  const markChatStarting = useCallback((): void => {
    setChat((current) => current ? {
      ...current,
      state: {
        ...current.state,
        status: "starting",
        error: undefined,
        startupStage: undefined,
        activeMessageId: undefined,
        interruptRequested: false,
      },
    } : current);
  }, [setChat]);

  const handleContinueFromHistory = useCallback(async (): Promise<boolean> => {
    if (isContinuingFromHistory) {
      return false;
    }
    setIsContinuingFromHistory(true);
    try {
      const recoveredChat = await apiRequest<Chat>(
        `/api/chats/${chatId}/continue-from-history`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          action: "Continue chat from history",
          fallbackMessage: "Failed to continue chat from history",
        },
      );
      applyChatSnapshot(recoveredChat);
      toast.success("Chat continued in a new agent session.");
      return true;
    } catch (recoveryError) {
      toast.error(String(recoveryError));
      return false;
    } finally {
      setIsContinuingFromHistory(false);
    }
  }, [
    applyChatSnapshot,
    chatId,
    isContinuingFromHistory,
    toast,
  ]);

  return {
    chat,
    transcript,
    loading,
    loadingTranscript,
    error,
    notFound,
    isActive: chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false,
    refreshChat,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleContinueFromHistory,
    isContinuingFromHistory,
  };
}
