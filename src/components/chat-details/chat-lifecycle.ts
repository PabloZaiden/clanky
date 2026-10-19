import { useCallback, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type {
  Chat,
  ChatSnapshot,
} from "@/shared";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { useTranscriptResource } from "../../hooks";
import { useChatResourceState } from "../../hooks/chat-state-context";
import { apiRequest } from "../../lib/api-client";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import {
  hasSameChatPresentation,
  mergeChatSummarySnapshot,
  reuseChatSnapshotPresentation,
} from "../../utils/chat-snapshot";
import type { ChatLifecycleResult } from "./types";

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
    refreshChat,
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
