import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest, readApiResponse, requestApiResponse } from "../lib/api-client";
import type { Chat, ChatEvent } from "@/shared";
import type {
  CreateChatRequest,
  CreateExecutionHostChatRequest,
  InterruptChatRequest,
  SendChatMessageRequest,
  UpdateChatRequest,
} from "@/contracts";
import {
  getExecutionHostSourceId,
  getRegisteredSshServerId,
  type ExecutionHostRef,
} from "@/shared/execution-host";
import { DEFAULT_CHAT_INTERRUPT_REASON, isStandaloneChat } from "@/shared";
import { applyChatStatusEvent, mergeChatSummarySnapshot } from "../utils/chat-snapshot";
import { createRefreshCoordinator } from "../lib/refresh-coordinator";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../lib/request-lifecycle";
import { getClankyClientId } from "../lib/clanky-client-id";
import { getStoredSshCredentialToken } from "../lib/ssh-browser-credentials";
import { useRealtimeRefreshWithRecovery, useRealtimeStream } from "./useRealtimeStream";
import { useChatActivityState } from "./chat-state-context";
import { useRefreshOnForeground } from "./useDocumentVisibility";
import type { ResourceRefreshOptions } from "./useResourceRefresh";

const log = createLogger("useChats");
function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((left, right) => {
    return right.config.updatedAt.localeCompare(left.config.updatedAt);
  });
}

function upsertChat(chats: Chat[], chat: Chat): Chat[] {
  const next = chats.filter((item) => isStandaloneChat(item) && item.config.id !== chat.config.id);
  if (!isStandaloneChat(chat)) {
    return sortChats(next);
  }

  const current = chats.find((item) => item.config.id === chat.config.id && isStandaloneChat(item));
  next.push(current ? mergeChatSummarySnapshot(current, chat) : chat);
  return sortChats(next);
}

export interface UseChatsResult {
  chats: Chat[];
  loading: boolean;
  error: string | null;
  refresh: (options?: ResourceRefreshOptions) => Promise<void>;
  refreshChat: (id: string) => Promise<void>;
  getChat: (id: string) => Chat | undefined;
  createChat: (request: CreateChatRequest) => Promise<Chat | null>;
  createChatHere: (sourceChatId: string) => Promise<Chat>;
  createExecutionHostChat: (
    host: ExecutionHostRef,
    request: CreateExecutionHostChatRequest,
  ) => Promise<Chat>;
  updateChat: (id: string, request: UpdateChatRequest) => Promise<Chat | null>;
  markChatDone: (id: string) => Promise<Chat | null>;
  deleteChat: (id: string) => Promise<boolean>;
  sendMessage: (id: string, request: SendChatMessageRequest) => Promise<boolean>;
  interruptChat: (id: string, request?: InterruptChatRequest) => Promise<Chat | null>;
  reconnectChat: (id: string) => Promise<Chat | null>;
}

export function useChats(): UseChatsResult {
  const { chats: allChats, setChats: setAllChats, getChat, recordActivity } = useChatActivityState();
  const chats = useMemo(() => allChats.filter(isStandaloneChat), [allChats]);
  const setChats = useCallback((
    update: SetStateAction<Chat[]>,
    options: { immediateActivityId?: string } = {},
  ): void => {
    setAllChats((current) => {
      const standalone = current.filter(isStandaloneChat);
      const next = typeof update === "function" ? update(standalone) : update;
      return [...current.filter((chat) => !isStandaloneChat(chat)), ...next];
    }, options);
  }, [setAllChats]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const refreshCoordinatorRef = useRef(createRefreshCoordinator<void>());

  const applyChat = useCallback((chat: Chat, allowInsert = false): void => {
    setChats((current) => allowInsert || current.some((entry) => entry.config.id === chat.config.id)
      ? upsertChat(current, chat)
      : current, { immediateActivityId: chat.config.id });
  }, [setChats]);

  const refresh = useCallback((options: ResourceRefreshOptions = {}) => {
    const method = options.afterCurrent ? "runAfterCurrent" : "run";
    return refreshCoordinatorRef.current[method](async () => {
      const showLoading = options.showLoading ?? true;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        if (showLoading) {
          setLoading(true);
        }
        setError(null);
        const data = await apiRequest<Chat[]>("/api/chats", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]),
          action: "Fetch chats",
          fallbackMessage: "Failed to fetch chats",
        });
        if (controller.signal.aborted) {
          return;
        }
        setChats((current) => {
          const byId = new Map(current.map((chat) => [chat.config.id, chat]));
          return sortChats(data.filter(isStandaloneChat).map((chat) => {
            const previous = byId.get(chat.config.id);
            return previous ? mergeChatSummarySnapshot(previous, chat) : chat;
          }));
        });
      } catch (refreshError) {
        if (controller.signal.aborted) {
          return;
        }
        setError(String(refreshError));
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (!controller.signal.aborted && showLoading) {
          setLoading(false);
        }
      }
    });
  }, [setChats]);

  useRefreshOnForeground(() => refresh({ showLoading: false, afterCurrent: true }));

  const refreshChat = useCallback(async (id: string) => {
    try {
      const response = await requestApiResponse("/api/chats", {
        action: "Refresh chat",
        fallbackMessage: "Failed to fetch chat",
        acceptedStatuses: [404],
      });
      if (response.status === 404) {
        setChats((prev) => prev.filter((chat) => chat.config.id !== id));
        return;
      }
      const chats = (await readApiResponse<Chat[]>(response)).filter(isStandaloneChat);
      const chat = chats.find((item) => item.config.id === id);
      if (!chat) {
        setChats((prev) => prev.filter((item) => item.config.id !== id));
        return;
      }
      setChats((prev) => {
        return upsertChat(prev, chat);
      });
    } catch (refreshError) {
      log.error("Failed to refresh chat", { chatId: id, error: String(refreshError) });
    }
  }, [setChats]);

  const createChat = useCallback(async (request: CreateChatRequest): Promise<Chat | null> => {
    try {
      const chat = await apiRequest<Chat>("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create chat",
        fallbackMessage: "Failed to create chat",
      });
      applyChat(chat, true);
      return chat;
    } catch (createError) {
      log.error("Failed to create chat", {
        workspaceId: request.workspaceId,
        error: String(createError),
      });
      setError(String(createError));
      return null;
    }
  }, [applyChat]);

  const createChatHere = useCallback(async (sourceChatId: string): Promise<Chat> => {
    const chat = await apiRequest<Chat>(`/api/chats/${encodeURIComponent(sourceChatId)}/new-here`, {
      method: "POST",
      action: "Create chat here",
      fallbackMessage: "Failed to create chat here",
    });
    applyChat(chat, true);
    return chat;
  }, [applyChat]);

  const createExecutionHostChat = useCallback(async (
    host: ExecutionHostRef,
    request: CreateExecutionHostChatRequest,
  ): Promise<Chat> => {
    const hostId = getExecutionHostSourceId(host);
    const chat = await apiRequest<Chat>(`/api/execution-hosts/${host.kind}/${encodeURIComponent(hostId)}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Create execution-host chat",
      fallbackMessage: "Failed to create chat",
    });
    applyChat(chat, true);
    return chat;
  }, [applyChat]);

  const updateChat = useCallback(async (id: string, request: UpdateChatRequest): Promise<Chat | null> => {
    try {
      const chat = await apiRequest<Chat>(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update chat",
        fallbackMessage: "Failed to update chat",
      });
      applyChat(chat);
      return chat;
    } catch (updateError) {
      log.error("Failed to update chat", { chatId: id, error: String(updateError) });
      setError(String(updateError));
      return null;
    }
  }, [applyChat]);

  const markChatDone = useCallback(async (id: string): Promise<Chat | null> => {
    try {
      const chat = await apiRequest<Chat>(`/api/chats/${id}/done`, {
        method: "POST",
        action: "Mark chat as done",
        fallbackMessage: "Failed to mark chat as done",
      });
      applyChat(chat);
      return chat;
    } catch (doneError) {
      log.error("Failed to mark chat as done", { chatId: id, error: String(doneError) });
      setError(String(doneError));
      return null;
    }
  }, [applyChat]);

  const deleteChat = useCallback(async (id: string): Promise<boolean> => {
    try {
      const chat = chats.find((entry) => entry.config.id === id);
      const recovery = chat?.state.harness?.historyRecovery;
      const serverId = chat && !isStandaloneChat(chat) && recovery && recovery.status !== "complete"
        ? getRegisteredSshServerId(recovery.executionHost.host)
        : null;
      const credentialToken = serverId
        ? await getStoredSshCredentialToken(serverId)
        : null;
      await apiRequest<unknown>(`/api/chats/${id}`, {
        method: "DELETE",
        ...(credentialToken
          ? { headers: { "x-clanky-ssh-credential-token": credentialToken } }
          : {}),
        action: "Delete chat",
        fallbackMessage: "Failed to delete chat",
      });
      setChats((prev) => prev.filter((chat) => chat.config.id !== id));
      return true;
    } catch (deleteError) {
      log.error("Failed to delete chat", { chatId: id, error: String(deleteError) });
      setError(String(deleteError));
      return false;
    }
  }, [chats, setChats]);

  const sendMessage = useCallback(async (id: string, request: SendChatMessageRequest): Promise<boolean> => {
    try {
      const result = await apiRequest<{ chat: Chat }>(`/api/chats/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, clientId: request.clientId ?? getClankyClientId() }),
        action: "Send chat message",
        fallbackMessage: "Failed to send chat message",
      });
      applyChat(result.chat);
      return true;
    } catch (sendError) {
      log.error("Failed to send chat message", { chatId: id, error: String(sendError) });
      setError(String(sendError));
      return false;
    }
  }, [applyChat]);

  const interruptChat = useCallback(async (id: string, request?: InterruptChatRequest): Promise<Chat | null> => {
    try {
      const chat = await apiRequest<Chat>(`/api/chats/${id}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: request?.reason ?? DEFAULT_CHAT_INTERRUPT_REASON,
        }),
        action: "Interrupt chat",
        fallbackMessage: "Failed to interrupt chat",
      });
      applyChat(chat);
      return chat;
    } catch (interruptError) {
      log.error("Failed to interrupt chat", { chatId: id, error: String(interruptError) });
      setError(String(interruptError));
      return null;
    }
  }, [applyChat]);

  const reconnectChat = useCallback(async (id: string): Promise<Chat | null> => {
    try {
      const chat = await apiRequest<Chat>(`/api/chats/${id}/reconnect`, {
        method: "POST",
        action: "Reconnect chat",
        fallbackMessage: "Failed to reconnect chat",
      });
      applyChat(chat);
      return chat;
    } catch (reconnectError) {
      log.error("Failed to reconnect chat", { chatId: id, error: String(reconnectError) });
      setError(String(reconnectError));
      return null;
    }
  }, [applyChat]);

  useRealtimeRefreshWithRecovery({
    resources: ["chats"],
    filters: { resource: "chats" },
    refresh: () => refresh({ showLoading: false, afterCurrent: true }),
    onReconnect: () => refresh({ showLoading: false, afterCurrent: true }),
  });

  useRealtimeStream<ChatEvent>({
    filters: {},
    predicate: (event) => event.type.startsWith("chat."),
    onEvent: (event) => {
      switch (event.type) {
        case "chat.status":
          setChats((current) => current.map((chat) => (
            chat.config.id === event.chatId
              ? applyChatStatusEvent(chat, event)
              : chat
          )));
          break;
        case "chat.message":
          if (event.message.role === "assistant") {
            recordActivity(event.chatId, event.timestamp);
          } else if (event.message.role === "user") {
            recordActivity(event.chatId, event.timestamp, "user");
          }
          break;
        case "chat.message.delta":
          if (event.role === "assistant") {
            recordActivity(event.chatId, event.timestamp);
          }
          break;
        case "chat.log":
        case "chat.log.delta":
        case "chat.tool_call":
        case "chat.tool_call.extra":
          recordActivity(event.chatId, event.timestamp);
          break;
      }
    },
    onReconnect: () => refresh({ showLoading: false, afterCurrent: true }),
  });

  useEffect(() => {
    void refresh();
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      refreshCoordinatorRef.current.reset();
    };
  }, [refresh]);

  return {
    chats,
    loading,
    error,
    refresh,
    refreshChat,
    getChat,
    createChat,
    createChatHere,
    createExecutionHostChat,
    updateChat,
    markChatDone,
    deleteChat,
    sendMessage,
    interruptChat,
    reconnectChat,
  };
}
