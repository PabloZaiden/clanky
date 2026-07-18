import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import type {
  Chat,
  MessageData,
  TaskLogEntry,
  ToolCallData,
} from "@/shared";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";
import { useRealtimeRefreshWithRecovery, useRealtimeStream } from "../../hooks";
import { appFetch } from "../../lib/public-path";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import {
  applyChatStatusEvent,
  getStreamingActivityStatus,
  mergeChatSnapshot,
} from "../../utils/chat-snapshot";
import type {
  ChatLifecycleResult,
  ChatRefreshOptions,
  ChatStreamEvent,
} from "./types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "interrupting", "reconnecting"]);

export async function parseChatError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function getChatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function upsertById<T extends { id: string; timestamp?: string }>(items: T[], item: T): T[] {
  const next = items.filter((entry) => entry.id !== item.id);
  next.push(item);
  return next.sort((left, right) => {
    const leftTimestamp = left.timestamp ?? "";
    const rightTimestamp = right.timestamp ?? "";
    const byTimestamp = leftTimestamp.localeCompare(rightTimestamp);
    return byTimestamp !== 0 ? byTimestamp : left.id.localeCompare(right.id);
  }).slice(-1000);
}

interface ChatStreamUpdate {
  chat: Chat;
  refreshOptions?: ChatRefreshOptions;
}

function applyChatStreamEvent(current: Chat, event: ChatStreamEvent): ChatStreamUpdate {
  switch (event.type) {
    case "chat.status":
      return {
        chat: applyChatStatusEvent(current, event.status, event.timestamp),
      };
    case "chat.message":
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: event.message.role === "assistant"
              ? getStreamingActivityStatus(current.state.status)
              : current.state.status,
            lastActivityAt: event.timestamp,
            messages: upsertById(current.state.messages as MessageData[], event.message),
          },
        },
      };
    case "chat.message.delta": {
      const messages = current.state.messages as MessageData[];
      const existingIndex = messages.findIndex((messageEntry) => messageEntry.id === event.messageId);
      if (existingIndex < 0 && event.baseLength !== 0) {
        return { chat: current, refreshOptions: { showLoading: false } };
      }
      if (existingIndex >= 0 && messages[existingIndex]!.content.length !== event.baseLength) {
        return { chat: current, refreshOptions: { showLoading: false } };
      }
      const nextMessage: MessageData = existingIndex >= 0
        ? {
            ...messages[existingIndex]!,
            content: `${messages[existingIndex]!.content}${event.delta}`,
            timestamp: messages[existingIndex]!.timestamp,
          }
        : {
            id: event.messageId,
            role: event.role,
            content: event.delta,
            timestamp: event.messageTimestamp,
          };
      const nextMessages = existingIndex >= 0
        ? messages.map((messageEntry, index) => index === existingIndex ? nextMessage : messageEntry)
        : [...messages, nextMessage].slice(-1000);
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: event.role === "assistant"
              ? getStreamingActivityStatus(current.state.status)
              : current.state.status,
            activeMessageId: event.messageId,
            lastActivityAt: event.timestamp,
            messages: nextMessages,
          },
        },
      };
    }
    case "chat.tool_call":
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
            toolCalls: upsertById(
              current.state.toolCalls as ToolCallData[],
              mergeToolCallRecord(
                (current.state.toolCalls as ToolCallData[]).find((toolCall) => toolCall.id === event.tool.id),
                event.tool,
              ),
            ),
          },
        },
      };
    case "chat.tool_call.extra":
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
            toolCalls: (current.state.toolCalls as ToolCallData[]).map((toolCall) => (
              toolCall.id === event.toolId
                ? { ...toolCall, extras: upsertToolCallExtra(toolCall.extras, event.extra) }
                : toolCall
            )),
          },
        },
      };
    case "chat.log":
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
            logs: upsertById(current.state.logs as TaskLogEntry[], event.log),
          },
        },
      };
    case "chat.log.delta": {
      const logs = current.state.logs as TaskLogEntry[];
      const existingIndex = logs.findIndex((logEntry) => logEntry.id === event.logId);
      if (existingIndex < 0 && event.baseLength !== 0) {
        return { chat: current, refreshOptions: { showLoading: false } };
      }
      const existingContent = existingIndex >= 0
        ? logs[existingIndex]!.details?.["responseContent"]
        : "";
      if (typeof existingContent !== "string" || existingContent.length !== event.baseLength) {
        return { chat: current, refreshOptions: {} };
      }
      const nextLog: TaskLogEntry = existingIndex >= 0
        ? {
            ...logs[existingIndex]!,
            level: event.level,
            message: event.message,
            details: {
              ...logs[existingIndex]!.details,
              logKind: event.logKind,
              responseContent: `${existingContent}${event.delta}`,
            },
            timestamp: event.logTimestamp,
          }
        : {
            id: event.logId,
            level: event.level,
            message: event.message,
            details: {
              logKind: event.logKind,
              responseContent: event.delta,
            },
            timestamp: event.logTimestamp,
          };
      const nextLogs = existingIndex >= 0
        ? logs.map((logEntry, index) => index === existingIndex ? nextLog : logEntry)
        : [...logs, nextLog].slice(-1000);
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
            logs: nextLogs,
          },
        },
      };
    }
  }
}

export function useChatLifecycle(chatId: string): ChatLifecycleResult {
  const toast = useToast();
  const [chat, setChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const mountedRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const refreshShowLoadingRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const reconnectAttemptedRef = useRef(false);

  const setChatState = useCallback((nextChat: Chat | null) => {
    chatRef.current = nextChat;
    setChat(nextChat);
  }, []);

  const refreshChat = useCallback(async (options: ChatRefreshOptions = {}): Promise<void> => {
    const showLoading = options.showLoading ?? true;
    const previousController = refreshControllerRef.current;
    if (previousController && refreshShowLoadingRef.current && mountedRef.current) {
      setLoading(false);
    }
    previousController?.abort();
    const controller = new AbortController();
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    refreshControllerRef.current = controller;
    refreshShowLoadingRef.current = showLoading;

    try {
      if (showLoading && mountedRef.current) {
        setLoading(true);
      }
      if (mountedRef.current) {
        setError(null);
      }
      const response = await appFetch(`/api/chats/${chatId}`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted
        || !mountedRef.current
        || requestId !== refreshRequestIdRef.current
      ) {
        return;
      }
      if (!response.ok) {
        if (response.status === 404) {
          setChatState(null);
          setError("Chat not found");
          return;
        }
        throw new Error(await parseChatError(response, "Failed to fetch chat"));
      }
      const data = (await response.json()) as Chat;
      setChatState(chatRef.current ? mergeChatSnapshot(chatRef.current, data) : data);
    } catch (refreshError) {
      if (
        isAbortError(refreshError)
        || controller.signal.aborted
        || !mountedRef.current
        || requestId !== refreshRequestIdRef.current
      ) {
        return;
      }
      setError(String(refreshError));
    } finally {
      if (
        mountedRef.current
        && requestId === refreshRequestIdRef.current
        && showLoading
      ) {
        setLoading(false);
      }
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        refreshShowLoadingRef.current = false;
      }
    }
  }, [chatId, setChatState]);

  const applyChatSnapshot = useCallback((nextChat: Chat) => {
    if (!mountedRef.current || nextChat.config.id !== chatId) {
      return;
    }
    setChatState(chatRef.current ? mergeChatSnapshot(chatRef.current, nextChat) : nextChat);
  }, [chatId, setChatState]);

  const markChatStarting = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }
    const current = chatRef.current;
    if (!current) {
      return;
    }
    setChatState({
      ...current,
      state: {
        ...current.state,
        status: "starting",
        error: undefined,
        activeMessageId: undefined,
        interruptRequested: false,
      },
    });
  }, [setChatState]);

  const handleReconnect = useCallback(async (): Promise<void> => {
    try {
      const credentialToken = chatRef.current?.config.source?.kind === "ssh_server"
        ? await getStoredSshCredentialToken(chatRef.current.config.source.sshServerId)
        : null;
      const response = await appFetch(`/api/chats/${chatId}/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialToken ? { credentialToken } : {}),
      });
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to reconnect chat"));
      }
      const nextChat = (await response.json()) as Chat;
      applyChatSnapshot(nextChat);
    } catch (reconnectError) {
      toast.error(String(reconnectError));
    }
  }, [applyChatSnapshot, chatId, toast]);

  const handleEvent = useCallback((event: ChatStreamEvent) => {
    if (event.chatId !== chatId) {
      return;
    }
    const current = chatRef.current;
    if (!current) {
      return;
    }
    const update = applyChatStreamEvent(current, event);
    if (update.refreshOptions) {
      void refreshChat(update.refreshOptions);
      return;
    }
    if (update.chat !== current) {
      setChatState(update.chat);
    }
  }, [chatId, refreshChat, setChatState]);

  const { status: chatSocketStatus } = useRealtimeStream<ChatStreamEvent>({
    filters: { chatId },
    predicate: (event) => event.type.startsWith("chat."),
    onEvent: handleEvent,
    onReconnect: () => refreshChat({ showLoading: false }),
  });

  useRealtimeRefreshWithRecovery({
    resources: ["chats"],
    ids: [chatId],
    filters: { resource: "chats", id: chatId },
    refresh: (event) => {
      if (event.action === "deleted") {
        setChatState(null);
        setError("Chat not found");
        return;
      }
      return refreshChat({ showLoading: false });
    },
    onReconnect: () => refreshChat({ showLoading: false }),
  });

  useEffect(() => {
    mountedRef.current = true;
    chatRef.current = null;
    setChat(null);
    setLoading(true);
    setError(null);
    void refreshChat();

    return () => {
      mountedRef.current = false;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshShowLoadingRef.current = false;
      chatRef.current = null;
    };
  }, [chatId, refreshChat]);

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
    loading,
    error,
    isActive: chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false,
    needsSshCredentials: chat?.config.source?.kind === "ssh_server"
      && chat.state.connectionStatus === "needs_credentials",
    refreshChat,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
  };
}
