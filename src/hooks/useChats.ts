import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { createLogger, useLiveQuery, useRealtime, type ResourceRealtimeEvent } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import type { Chat, ChatActivityUpdate } from "@/shared";
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
import { mergeChatSummarySnapshot } from "../utils/chat-snapshot";
import { SNAPSHOT_REQUEST_TIMEOUT_MS } from "../lib/request-lifecycle";
import { getClankyClientId } from "../lib/clanky-client-id";
import { getStoredSshCredentialToken } from "../lib/ssh-browser-credentials";
import { useChatActivityState } from "./chat-state-context";

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

function reconcileChat(chats: Chat[] | undefined, chat: Chat, allowInsert = false): Chat[] | undefined {
  const summary = { ...chat, state: { ...chat.state, messages: [], logs: [], toolCalls: [] } };
  return allowInsert || chats?.some((entry) => entry.config.id === chat.config.id)
    ? upsertChat(chats ?? [], summary)
    : chats;
}

export interface UseChatsResult {
  chats: Chat[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const { chats: allChats, setChats: setAllChats, getChat, recordActivity } = useChatActivityState();
  const chats = useMemo(() => allChats.filter(isStandaloneChat), [allChats]);
  const query = useLiveQuery<Chat[]>({
    load: async (signal) => sortChats((await apiRequest<Chat[]>("/api/chats", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS)]),
      action: "Fetch chats",
      fallbackMessage: "Failed to fetch chats",
    })).filter(isStandaloneChat)),
    realtime: { resources: ["chats"] },
  });
  const mutate = query.mutate;
  const refresh = useCallback(async () => {
    setError(null);
    await query.refresh();
  }, [query.refresh]);

  useLayoutEffect(() => {
    if (!query.data) return;
    // Publish only query-owned cuts, merging against the shared owner's current
    // revisions and activity so detail streams and compact activity stay monotonic.
    setAllChats((current) => {
      const byId = new Map(current.map((chat) => [chat.config.id, chat]));
      const standalone = query.data!.map((chat) => {
        const previous = byId.get(chat.config.id);
        return previous ? mergeChatSummarySnapshot(previous, chat) : chat;
      });
      return [...current.filter((chat) => !isStandaloneChat(chat)), ...standalone];
    });
  }, [query.data, setAllChats]);

  const refreshChat = useCallback(async (_id: string) => {
    await query.refresh();
  }, [query.refresh]);

  const createChat = useCallback(async (request: CreateChatRequest): Promise<Chat | null> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<Chat>("/api/chats", {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Create chat",
        fallbackMessage: "Failed to create chat",
      }), (previous, chat) => reconcileChat(previous, chat, true));
    } catch (createError) {
      log.error("Failed to create chat", {
        workspaceId: request.workspaceId,
        error: String(createError),
      });
      setError(String(createError));
      return null;
    }
  }, [mutate]);

  const createChatHere = useCallback(async (sourceChatId: string): Promise<Chat> => {
    return await mutate((signal) => apiRequest<Chat>(`/api/chats/${encodeURIComponent(sourceChatId)}/new-here`, {
      signal,
      method: "POST",
      action: "Create chat here",
      fallbackMessage: "Failed to create chat here",
    }), (previous, chat) => reconcileChat(previous, chat, true));
  }, [mutate]);

  const createExecutionHostChat = useCallback(async (
    host: ExecutionHostRef,
    request: CreateExecutionHostChatRequest,
  ): Promise<Chat> => {
    const hostId = getExecutionHostSourceId(host);
    return await mutate((signal) => apiRequest<Chat>(`/api/execution-hosts/${host.kind}/${encodeURIComponent(hostId)}/chats`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Create execution-host chat",
      fallbackMessage: "Failed to create chat",
    }), (previous, chat) => reconcileChat(previous, chat, true));
  }, [mutate]);

  const updateChat = useCallback(async (id: string, request: UpdateChatRequest): Promise<Chat | null> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<Chat>(`/api/chats/${id}`, {
        signal,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        action: "Update chat",
        fallbackMessage: "Failed to update chat",
      }), reconcileChat);
    } catch (updateError) {
      log.error("Failed to update chat", { chatId: id, error: String(updateError) });
      setError(String(updateError));
      return null;
    }
  }, [mutate]);

  const markChatDone = useCallback(async (id: string): Promise<Chat | null> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<Chat>(`/api/chats/${id}/done`, {
        signal,
        method: "POST",
        action: "Mark chat as done",
        fallbackMessage: "Failed to mark chat as done",
      }), reconcileChat);
    } catch (doneError) {
      log.error("Failed to mark chat as done", { chatId: id, error: String(doneError) });
      setError(String(doneError));
      return null;
    }
  }, [mutate]);

  const deleteChat = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      await mutate(async (signal) => {
        const chat = chats.find((entry) => entry.config.id === id);
        const recovery = chat?.state.harness?.historyRecovery;
        const serverId = chat && !isStandaloneChat(chat) && recovery && recovery.status !== "complete"
          ? getRegisteredSshServerId(recovery.executionHost.host)
          : null;
        const credentialToken = serverId
          ? await getStoredSshCredentialToken(serverId)
          : null;
        await apiRequest<unknown>(`/api/chats/${id}`, {
          signal,
          method: "DELETE",
          ...(credentialToken
            ? { headers: { "x-clanky-ssh-credential-token": credentialToken } }
            : {}),
          action: "Delete chat",
          fallbackMessage: "Failed to delete chat",
        });
      }, (previous) => previous?.filter((chat) => chat.config.id !== id));
      return true;
    } catch (deleteError) {
      log.error("Failed to delete chat", { chatId: id, error: String(deleteError) });
      setError(String(deleteError));
      return false;
    }
  }, [chats, mutate]);

  const sendMessage = useCallback(async (id: string, request: SendChatMessageRequest): Promise<boolean> => {
    try {
      setError(null);
      await mutate((signal) => apiRequest<{ chat: Chat }>(`/api/chats/${id}/messages`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, clientId: request.clientId ?? getClankyClientId() }),
        action: "Send chat message",
        fallbackMessage: "Failed to send chat message",
      }), (previous, result) => reconcileChat(previous, result.chat));
      return true;
    } catch (sendError) {
      log.error("Failed to send chat message", { chatId: id, error: String(sendError) });
      setError(String(sendError));
      return false;
    }
  }, [mutate]);

  const interruptChat = useCallback(async (id: string, request?: InterruptChatRequest): Promise<Chat | null> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<Chat>(`/api/chats/${id}/interrupt`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: request?.reason ?? DEFAULT_CHAT_INTERRUPT_REASON,
        }),
        action: "Interrupt chat",
        fallbackMessage: "Failed to interrupt chat",
      }), reconcileChat);
    } catch (interruptError) {
      log.error("Failed to interrupt chat", { chatId: id, error: String(interruptError) });
      setError(String(interruptError));
      return null;
    }
  }, [mutate]);

  const reconnectChat = useCallback(async (id: string): Promise<Chat | null> => {
    try {
      setError(null);
      return await mutate((signal) => apiRequest<Chat>(`/api/chats/${id}/reconnect`, {
        signal,
        method: "POST",
        action: "Reconnect chat",
        fallbackMessage: "Failed to reconnect chat",
      }), reconcileChat);
    } catch (reconnectError) {
      log.error("Failed to reconnect chat", { chatId: id, error: String(reconnectError) });
      setError(String(reconnectError));
      return null;
    }
  }, [mutate]);
  useRealtime<ResourceRealtimeEvent<ChatActivityUpdate>>({
    resources: ["chat-activity"],
    trackLastEvent: false,
    onEvent: (event) => {
      if (event.id && event.payload) recordActivity(event.id, event.payload.timestamp, event.payload.source);
    },
  });

  return {
    chats,
    loading: query.data === undefined && query.loading,
    error: error ?? (query.error ? String(query.error) : null),
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
