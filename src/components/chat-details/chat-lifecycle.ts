import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ChatSnapshot,
  TranscriptStreamEvent,
} from "@/shared";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import {
  useRealtimeRefreshWithRecovery,
  useRealtimeStream,
  useTranscriptResource,
} from "../../hooks";
import { useRefreshOnForeground } from "../../hooks/useDocumentVisibility";
import { toTranscriptStreamEvent } from "../../hooks/transcript-event-adapter";
import { apiRequest } from "../../lib/api-client";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import {
  applyChatStatusEvent,
  hasSameChatPresentation,
  mergeChatSummarySnapshot,
  reuseChatSnapshotPresentation,
} from "../../utils/chat-snapshot";
import type {
  ChatLifecycleResult,
  ChatRefreshOptions,
  ChatStreamEvent,
} from "./types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "waiting", "interrupting", "reconnecting"]);

export function getChatRegisteredSshServerId(
  chat: Chat | null | undefined,
): string | null {
  const binding = chat?.config.source?.kind === "execution_host"
    ? chat.config.source.executionHost
    : chat?.config.executionHostBinding ?? chat?.state.session?.binding?.executionHost;
  return binding ? getRegisteredSshServerId(binding.host) : null;
}

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

function applyChatOperationalEvent(
  current: Chat,
  event: ChatStreamEvent,
): Chat {
  switch (event.type) {
    case "chat.status":
      return applyChatStatusEvent(current, event);
    case "chat.message":
    case "chat.message.delta":
    case "chat.tool_call":
    case "chat.tool_call.extra":
    case "chat.log":
    case "chat.log.delta":
      return {
        ...current,
        state: {
          ...current.state,
          lastActivityAt: event.timestamp > (current.state.lastActivityAt ?? "")
            ? event.timestamp : current.state.lastActivityAt,
        },
      };
  }
}

export function useChatLifecycle(chatId: string): ChatLifecycleResult {
  const toast = useToast();
  const [isContinuingFromHistory, setIsContinuingFromHistory] = useState(false);
  const mountedChatIdRef = useRef(chatId);
  const reconnectAttemptedRef = useRef(false);
  mountedChatIdRef.current = chatId;

  const transcriptResource = useTranscriptResource<Chat, ChatSnapshot>({
    resourceId: chatId,
    resourceLabel: "chat",
    baseUrl: `/api/chats/${encodeURIComponent(chatId)}`,
    decodeSnapshot: decodeChatSnapshot,
    mergeResource: mergeOperationalChatSnapshot,
    isResourcePresentationEqual: hasSameChatPresentation,
  });
  const {
    resource: chat,
    getResource: getChat,
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
    applyTranscriptEvent,
    clearResource,
  } = transcriptResource;
  const refreshChatCoalesced = transcriptResource.refreshCoalesced;
  useRefreshOnForeground(() => refreshChatCoalesced({ showLoading: false, afterCurrent: true }));

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

  const handleReconnect = useCallback(async (): Promise<void> => {
    try {
      const serverId = getChatRegisteredSshServerId(getChat());
      const credentialToken = serverId
        ? await getStoredSshCredentialToken(serverId)
        : null;
      const nextChat = await apiRequest<Chat>(`/api/chats/${chatId}/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialToken ? { credentialToken } : {}),
        action: "Reconnect chat",
        fallbackMessage: "Failed to reconnect chat",
      });
      applyChatSnapshot(nextChat);
    } catch (reconnectError) {
      toast.error(String(reconnectError));
    }
  }, [applyChatSnapshot, chatId, getChat, toast]);

  const handleContinueFromHistory = useCallback(async (): Promise<boolean> => {
    if (isContinuingFromHistory) {
      return false;
    }
    setIsContinuingFromHistory(true);
    try {
      const serverId = getChatRegisteredSshServerId(getChat());
      const credentialToken = serverId
        ? await getStoredSshCredentialToken(serverId)
        : null;
      const recoveredChat = await apiRequest<Chat>(
        `/api/chats/${chatId}/continue-from-history`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentialToken ? { credentialToken } : {}),
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
    getChat,
    isContinuingFromHistory,
    toast,
  ]);

  const handleEvent = useCallback((event: ChatStreamEvent): void => {
    if (event.chatId !== chatId) {
      return;
    }
    const current = getChat();
    if (!current) {
      return;
    }
    const nextChat = applyChatOperationalEvent(current, event);
    if (nextChat !== current) {
      setChat(nextChat);
    }
    const transcriptEvent = toTranscriptStreamEvent(event);
    if (transcriptEvent) {
      applyTranscriptEvent(transcriptEvent as TranscriptStreamEvent);
    }
  }, [applyTranscriptEvent, chatId, getChat, setChat]);

  const { status: chatSocketStatus } = useRealtimeStream<ChatStreamEvent>({
    filters: { chatId },
    predicate: (event) => event.type.startsWith("chat."),
    onEvent: handleEvent,
    onReconnect: () => refreshChatCoalesced({ showLoading: false, afterCurrent: true }),
  });

  useRealtimeRefreshWithRecovery({
    resources: ["chats"],
    ids: [chatId],
    filters: { resource: "chats", id: chatId },
    refresh: (event) => {
      if (event.action === "deleted") {
        clearResource("Chat not found");
        return;
      }
      return refreshChatCoalesced({ showLoading: false, afterCurrent: true });
    },
    onReconnect: () => refreshChatCoalesced({ showLoading: false, afterCurrent: true }),
  });

  useEffect(() => {
    void refreshChat();
  }, [refreshChat]);

  useEffect(() => {
    if (!chat || !chat.state.session?.id || !ACTIVE_CHAT_STATUSES.has(chat.state.status)) {
      reconnectAttemptedRef.current = false;
      return;
    }
    if (chatSocketStatus !== "error") {
      reconnectAttemptedRef.current = false;
      return;
    }
    if (reconnectAttemptedRef.current) {
      return;
    }
    reconnectAttemptedRef.current = true;
    void handleReconnect();
  }, [chat, chatSocketStatus, handleReconnect]);

  return {
    chat,
    transcript,
    loading,
    loadingTranscript,
    error,
    notFound,
    isActive: chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false,
    needsSshCredentials: chat !== null
      && getChatRegisteredSshServerId(chat) !== null
      && chat.state.connectionStatus === "needs_credentials",
    refreshChat: refreshChat as (options?: ChatRefreshOptions) => Promise<void>,
    refreshChatCoalesced: refreshChatCoalesced as (options?: ChatRefreshOptions) => Promise<void>,
    loadMoreTranscript,
    loadFullTranscript,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
    handleContinueFromHistory,
    isContinuingFromHistory,
  };
}
