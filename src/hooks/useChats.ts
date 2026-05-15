import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";
import type {
  Chat,
  ChatError,
  ChatEvent,
  CreateChatRequest,
  InterruptChatRequest,
  SendChatMessageRequest,
  UpdateChatRequest,
} from "../types";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "../types";
import { mergeChatSnapshot } from "../utils/chat-snapshot";
import { isChatEvent, useAppEvents } from "./useAppEvents";

const log = createLogger("useChats");
const TERMINAL_CHAT_STATUSES = new Set(["idle", "stopped", "failed"]);

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((left, right) => {
    return right.config.updatedAt.localeCompare(left.config.updatedAt);
  });
}

function upsertChat(chats: Chat[], chat: Chat): Chat[] {
  const next = chats.filter((item) => item.config.id !== chat.config.id);

  const current = chats.find((item) => item.config.id === chat.config.id);
  next.push(current ? mergeChatSnapshot(current, chat) : chat);
  return sortChats(next);
}

function updateChatState(chats: Chat[], id: string, updates: Partial<Chat["state"]>): Chat[] {
  return sortChats(chats.map((chat) => {
    if (chat.config.id !== id) {
      return chat;
    }

    return {
      ...chat,
      state: {
        ...chat.state,
        ...updates,
      },
    };
  }));
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export interface UseChatsResult {
  chats: Chat[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshChat: (id: string) => Promise<void>;
  getChat: (id: string) => Chat | undefined;
  createChat: (request: CreateChatRequest) => Promise<Chat | null>;
  updateChat: (id: string, request: UpdateChatRequest) => Promise<Chat | null>;
  deleteChat: (id: string) => Promise<boolean>;
  sendMessage: (id: string, request: SendChatMessageRequest) => Promise<boolean>;
  interruptChat: (id: string, request?: InterruptChatRequest) => Promise<Chat | null>;
  reconnectChat: (id: string) => Promise<Chat | null>;
}

export function useChats(): UseChatsResult {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/chats", { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to fetch chats"));
      }
      const data = (await response.json()) as Chat[];
      setChats(sortChats(data));
    } catch (refreshError) {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") {
        return;
      }
      setError(String(refreshError));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshChat = useCallback(async (id: string) => {
    try {
      const response = await appFetch(`/api/chats/${id}`);
      if (!response.ok) {
        if (response.status === 404) {
          setChats((prev) => prev.filter((chat) => chat.config.id !== id));
          return;
        }
        throw new Error(await parseError(response, "Failed to fetch chat"));
      }
      const chat = (await response.json()) as Chat;
      setChats((prev) => upsertChat(prev, chat));
    } catch (refreshError) {
      log.error("Failed to refresh chat", { chatId: id, error: String(refreshError) });
    }
  }, []);

  const getChat = useCallback(
    (id: string): Chat | undefined => chats.find((chat) => chat.config.id === id),
    [chats],
  );

  const createChat = useCallback(async (request: CreateChatRequest): Promise<Chat | null> => {
    try {
      const response = await appFetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to create chat"));
      }
      const chat = (await response.json()) as Chat;
      setChats((prev) => upsertChat(prev, chat));
      return chat;
    } catch (createError) {
      log.error("Failed to create chat", {
        workspaceId: request.workspaceId,
        error: String(createError),
      });
      setError(String(createError));
      return null;
    }
  }, []);

  const updateChat = useCallback(async (id: string, request: UpdateChatRequest): Promise<Chat | null> => {
    try {
      const response = await appFetch(`/api/chats/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to update chat"));
      }
      const chat = (await response.json()) as Chat;
      setChats((prev) => upsertChat(prev, chat));
      return chat;
    } catch (updateError) {
      log.error("Failed to update chat", { chatId: id, error: String(updateError) });
      setError(String(updateError));
      return null;
    }
  }, []);

  const deleteChat = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await appFetch(`/api/chats/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to delete chat"));
      }
      setChats((prev) => prev.filter((chat) => chat.config.id !== id));
      return true;
    } catch (deleteError) {
      log.error("Failed to delete chat", { chatId: id, error: String(deleteError) });
      setError(String(deleteError));
      return false;
    }
  }, []);

  const sendMessage = useCallback(async (id: string, request: SendChatMessageRequest): Promise<boolean> => {
    try {
      const response = await appFetch(`/api/chats/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to send chat message"));
      }
      return true;
    } catch (sendError) {
      log.error("Failed to send chat message", { chatId: id, error: String(sendError) });
      setError(String(sendError));
      return false;
    }
  }, []);

  const interruptChat = useCallback(async (id: string, request?: InterruptChatRequest): Promise<Chat | null> => {
    try {
      const response = await appFetch(`/api/chats/${id}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: request?.reason ?? DEFAULT_CHAT_INTERRUPT_REASON,
        }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to interrupt chat"));
      }
      const chat = (await response.json()) as Chat;
      setChats((prev) => upsertChat(prev, chat));
      return chat;
    } catch (interruptError) {
      log.error("Failed to interrupt chat", { chatId: id, error: String(interruptError) });
      setError(String(interruptError));
      return null;
    }
  }, []);

  const reconnectChat = useCallback(async (id: string): Promise<Chat | null> => {
    try {
      const response = await appFetch(`/api/chats/${id}/reconnect`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to reconnect chat"));
      }
      const chat = (await response.json()) as Chat;
      setChats((prev) => upsertChat(prev, chat));
      return chat;
    } catch (reconnectError) {
      log.error("Failed to reconnect chat", { chatId: id, error: String(reconnectError) });
      setError(String(reconnectError));
      return null;
    }
  }, []);

  useAppEvents<ChatEvent>((event) => {
    switch (event.type) {
      case "chat.updated":
        setChats((prev) => upsertChat(prev, event.chat));
        break;
      case "chat.created":
        void refresh();
        break;
      case "chat.deleted":
        setChats((prev) => prev.filter((chat) => chat.config.id !== event.chatId));
        break;
      case "chat.status":
        setChats((prev) => updateChatState(prev, event.chatId, {
          status: event.status,
          ...(TERMINAL_CHAT_STATUSES.has(event.status) ? { activeMessageId: undefined } : {}),
          ...(event.status === "failed" ? {} : { error: undefined }),
          lastActivityAt: event.timestamp,
        }));
        break;
      case "chat.interrupted":
        setChats((prev) => updateChatState(prev, event.chatId, {
          status: "idle",
          activeMessageId: undefined,
          lastActivityAt: event.timestamp,
        }));
        break;
      case "chat.error": {
        const chatError: ChatError = {
          message: event.message,
          timestamp: event.timestamp,
        };
        setChats((prev) => updateChatState(prev, event.chatId, {
          status: "failed",
          error: chatError,
          lastActivityAt: event.timestamp,
        }));
        break;
      }
    }
  }, isChatEvent);

  useEffect(() => {
    void refresh();
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
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
    updateChat,
    deleteChat,
    sendMessage,
    interruptChat,
    reconnectChat,
  };
}
