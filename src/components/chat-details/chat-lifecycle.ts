import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { mergeTranscriptPages, mergeTranscriptRecords, mergeTranscriptToolCalls } from "@/shared";
import type {
  Chat,
  ChatSnapshot,
  ChatTranscriptPage,
  MessageData,
  TaskLogEntry,
  ToolCallData,
  ToolCallDisplayData,
} from "@/shared";
import { shouldIncludeChatTranscriptLog } from "@/shared";
import {
  isToolCallDetailsStale,
  isToolCallSummary,
  mergeToolCallDisplayData,
  upsertToolCallExtra,
} from "@/shared/tool-call";
import { useRealtimeRefreshWithRecovery, useRealtimeStream } from "../../hooks";
import { appFetch } from "../../lib/public-path";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";
import {
  applyChatStatusEvent,
  getStreamingActivityStatus,
} from "../../utils/chat-snapshot";
import type {
  ChatLifecycleResult,
  ChatRefreshOptions,
  ChatStreamEvent,
  ChatTranscriptViewState,
} from "./types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "interrupting", "reconnecting"]);
const INITIAL_TRANSCRIPT_PAGE_SIZE = 100;
const MAX_LIVE_TRANSCRIPT_ENTRIES = 10_000;

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
  const existingIndex = items.findIndex((entry) => entry.id === item.id);
  const next = existingIndex === -1
    ? [...items, item]
    : items.map((entry, index) => index === existingIndex ? item : entry);
  return next
    .sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""))
    .slice(-MAX_LIVE_TRANSCRIPT_ENTRIES);
}

function createEmptyTranscript(): ChatTranscriptViewState {
  return {
    messages: [],
    logs: [],
    toolCalls: [],
    hasOlder: false,
    revision: "",
    totalEntries: 0,
    loadingOlder: false,
  };
}

function hydrateChatSnapshot(snapshot: ChatSnapshot): {
  chat: Chat;
  transcript: ChatTranscriptViewState;
} {
  return {
    chat: {
      config: snapshot.config,
      state: {
        ...snapshot.state,
        messages: [],
        logs: [],
        toolCalls: [],
      },
    },
    transcript: {
      ...snapshot.transcript,
      loadingOlder: false,
    },
  };
}

function mergeDisplayToolCall(
  existing: ToolCallDisplayData | undefined,
  incoming: ToolCallDisplayData,
): ToolCallDisplayData {
  return mergeToolCallDisplayData(existing, incoming);
}

function mergeOperationalChatSnapshot(current: Chat, incoming: Chat): Chat {
  return {
    ...current,
    config: {
      ...current.config,
      ...incoming.config,
    },
    state: {
      ...current.state,
      ...incoming.state,
      messages: [],
      logs: [],
      toolCalls: [],
    },
  };
}

interface ChatStreamUpdate {
  chat: Chat;
  transcript?: ChatTranscriptViewState;
  refreshOptions?: ChatRefreshOptions;
}

function applyChatStreamEvent(
  current: Chat,
  transcript: ChatTranscriptViewState,
  event: ChatStreamEvent,
): ChatStreamUpdate {
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
          },
        },
        transcript: {
          ...transcript,
          messages: upsertById(transcript.messages as MessageData[], event.message),
        },
      };
    case "chat.message.delta": {
      const messages = transcript.messages as MessageData[];
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
        : [...messages, nextMessage];
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
          },
        },
        transcript: {
          ...transcript,
          messages: nextMessages.slice(-MAX_LIVE_TRANSCRIPT_ENTRIES),
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
          },
        },
        transcript: {
          ...transcript,
          toolCalls: upsertById(
            transcript.toolCalls,
            mergeDisplayToolCall(
              transcript.toolCalls.find((toolCall) => toolCall.id === event.tool.id),
              event.tool,
            ),
          ),
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
          },
        },
        transcript: {
          ...transcript,
          toolCalls: transcript.toolCalls.map((toolCall) => {
            if (toolCall.id !== event.toolId || isToolCallSummary(toolCall)) {
              return toolCall;
            }
            return {
              ...toolCall,
              extras: upsertToolCallExtra(toolCall.extras, event.extra),
            };
          }),
        },
      };
    case "chat.log":
      if (!shouldIncludeChatTranscriptLog(event.log)) {
        return {
          chat: {
            ...current,
            state: {
              ...current.state,
              status: getStreamingActivityStatus(current.state.status),
              lastActivityAt: event.timestamp,
            },
          },
        };
      }
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
          },
        },
        transcript: {
          ...transcript,
          logs: upsertById(transcript.logs as TaskLogEntry[], event.log),
        },
      };
    case "chat.log.delta": {
      if (event.logKind === "response" || event.logKind === "tool" || event.logKind === "system") {
        return {
          chat: {
            ...current,
            state: {
              ...current.state,
              status: getStreamingActivityStatus(current.state.status),
              lastActivityAt: event.timestamp,
            },
          },
        };
      }

      const logs = transcript.logs as TaskLogEntry[];
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
      if (!shouldIncludeChatTranscriptLog(nextLog)) {
        return {
          chat: {
            ...current,
            state: {
              ...current.state,
              status: getStreamingActivityStatus(current.state.status),
              lastActivityAt: event.timestamp,
            },
          },
        };
      }
      const nextLogs = existingIndex >= 0
        ? logs.map((logEntry, index) => index === existingIndex ? nextLog : logEntry)
        : [...logs, nextLog];
      return {
        chat: {
          ...current,
          state: {
            ...current.state,
            status: getStreamingActivityStatus(current.state.status),
            lastActivityAt: event.timestamp,
          },
        },
        transcript: {
          ...transcript,
          logs: nextLogs.slice(-MAX_LIVE_TRANSCRIPT_ENTRIES),
        },
      };
    }
  }
}

export function useChatLifecycle(chatId: string): ChatLifecycleResult {
  const toast = useToast();
  const [chat, setChat] = useState<Chat | null>(null);
  const [transcript, setTranscript] = useState<ChatTranscriptViewState>(createEmptyTranscript);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const transcriptRef = useRef<ChatTranscriptViewState>(createEmptyTranscript());
  const mountedRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const olderControllerRef = useRef<AbortController | null>(null);
  const detailControllersRef = useRef(new Map<string, AbortController>());
  const refreshShowLoadingRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const reconnectAttemptedRef = useRef(false);
  const snapshotEtagRef = useRef<string | null>(null);
  const toolDetailsCacheRef = useRef(new Map<string, ToolCallData>());

  const setChatState = useCallback((nextChat: Chat | null) => {
    chatRef.current = nextChat;
    setChat(nextChat);
  }, []);

  const setTranscriptState = useCallback((nextTranscript: ChatTranscriptViewState) => {
    transcriptRef.current = nextTranscript;
    setTranscript(nextTranscript);
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
      const headers = new Headers();
      if (snapshotEtagRef.current) {
        headers.set("If-None-Match", snapshotEtagRef.current);
      }
      const response = await appFetch(
        `/api/chats/${chatId}/snapshot?limit=${INITIAL_TRANSCRIPT_PAGE_SIZE}`,
        {
          signal: controller.signal,
          headers,
        },
      );
      if (
        controller.signal.aborted
        || !mountedRef.current
        || requestId !== refreshRequestIdRef.current
      ) {
        return;
      }
      if (response.status === 304) {
        return;
      }
      if (!response.ok) {
        if (response.status === 404) {
          setChatState(null);
          setTranscriptState(createEmptyTranscript());
          setError("Chat not found");
          return;
        }
        throw new Error(await parseChatError(response, "Failed to fetch chat"));
      }
      const data = await response.json() as ChatSnapshot;
      const hydrated = hydrateChatSnapshot(data);
      snapshotEtagRef.current = response.headers.get("ETag");
      setChatState(hydrated.chat);
      const currentTranscript = transcriptRef.current;
      setTranscriptState({
        ...mergeTranscriptPages(currentTranscript, hydrated.transcript),
        loadingOlder: currentTranscript.loadingOlder,
      });
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
  }, [chatId, setChatState, setTranscriptState]);

  const loadOlderEntries = useCallback(async (): Promise<void> => {
    const currentTranscript = transcriptRef.current;
    if (
      !mountedRef.current
      || currentTranscript.loadingOlder
      || !currentTranscript.hasOlder
      || !currentTranscript.nextCursor
    ) {
      return;
    }

    olderControllerRef.current?.abort();
    const controller = new AbortController();
    olderControllerRef.current = controller;
    setTranscriptState({ ...currentTranscript, loadingOlder: true });

    try {
      const params = new URLSearchParams({
        limit: String(INITIAL_TRANSCRIPT_PAGE_SIZE),
        before: currentTranscript.nextCursor,
      });
      const response = await appFetch(`/api/chats/${chatId}/transcript?${params.toString()}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mountedRef.current) {
        return;
      }
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to load older transcript entries"));
      }
      const page = await response.json() as ChatTranscriptPage;
      const latestTranscript = transcriptRef.current;
      setTranscriptState({
        messages: mergeTranscriptRecords(latestTranscript.messages, page.messages),
        logs: mergeTranscriptRecords(latestTranscript.logs, page.logs),
        toolCalls: mergeTranscriptToolCalls(latestTranscript.toolCalls, page.toolCalls),
        hasOlder: page.hasOlder,
        nextCursor: page.nextCursor,
        revision: page.revision,
        totalEntries: page.totalEntries,
        loadingOlder: false,
      });
    } catch (loadError) {
      if (!isAbortError(loadError) && !controller.signal.aborted && mountedRef.current) {
        setError(String(loadError));
      }
    } finally {
      if (olderControllerRef.current === controller) {
        olderControllerRef.current = null;
      }
      if (
        mountedRef.current
        && !controller.signal.aborted
        && transcriptRef.current.loadingOlder
      ) {
        setTranscriptState({ ...transcriptRef.current, loadingOlder: false });
      }
    }
  }, [chatId, setTranscriptState]);

  const loadToolCallDetails = useCallback(async (toolCallId: string): Promise<ToolCallData | null> => {
    const currentTool = transcriptRef.current.toolCalls.find((toolCall) => toolCall.id === toolCallId);
    const cached = toolDetailsCacheRef.current.get(toolCallId);
    if (
      cached
      && (!currentTool || !isToolCallSummary(currentTool) || !isToolCallDetailsStale(currentTool, cached))
    ) {
      return cached;
    }
    if (cached) {
      toolDetailsCacheRef.current.delete(toolCallId);
    }
    if (currentTool && !isToolCallSummary(currentTool)) {
      toolDetailsCacheRef.current.set(toolCallId, currentTool);
      return currentTool;
    }

    const existingController = detailControllersRef.current.get(toolCallId);
    existingController?.abort();
    const controller = new AbortController();
    detailControllersRef.current.set(toolCallId, controller);

    try {
      const response = await appFetch(
        `/api/chats/${chatId}/tool-calls/${encodeURIComponent(toolCallId)}`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to load tool call details"));
      }
      const tool = await response.json() as ToolCallData;
      toolDetailsCacheRef.current.set(toolCallId, tool);
      setTranscriptState({
        ...transcriptRef.current,
        toolCalls: transcriptRef.current.toolCalls.map((entry) => (
          entry.id === toolCallId
            ? mergeToolCallDisplayData(entry, tool)
            : entry
        )),
      });
      return tool;
    } finally {
      if (detailControllersRef.current.get(toolCallId) === controller) {
        detailControllersRef.current.delete(toolCallId);
      }
    }
  }, [chatId, setTranscriptState]);

  const applyChatSnapshot = useCallback((nextChat: Chat) => {
    if (!mountedRef.current || nextChat.config.id !== chatId) {
      return;
    }
    const current = chatRef.current;
    setChatState(current ? mergeOperationalChatSnapshot(current, nextChat) : {
      ...nextChat,
      state: {
        ...nextChat.state,
        messages: [],
        logs: [],
        toolCalls: [],
      },
    });
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
      const nextChat = await response.json() as Chat;
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
    const update = applyChatStreamEvent(current, transcriptRef.current, event);
    if (update.refreshOptions) {
      void refreshChat(update.refreshOptions);
      return;
    }
    if (update.chat !== current) {
      setChatState(update.chat);
    }
    if (update.transcript) {
      setTranscriptState(update.transcript);
    }
  }, [chatId, refreshChat, setChatState, setTranscriptState]);

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
        setTranscriptState(createEmptyTranscript());
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
    transcriptRef.current = createEmptyTranscript();
    setChat(null);
    setTranscript(createEmptyTranscript());
    setLoading(true);
    setError(null);
    snapshotEtagRef.current = null;
    toolDetailsCacheRef.current.clear();
    void refreshChat();

    return () => {
      mountedRef.current = false;
      refreshControllerRef.current?.abort();
      olderControllerRef.current?.abort();
      for (const controller of detailControllersRef.current.values()) {
        controller.abort();
      }
      detailControllersRef.current.clear();
      refreshControllerRef.current = null;
      olderControllerRef.current = null;
      refreshShowLoadingRef.current = false;
      chatRef.current = null;
      transcriptRef.current = createEmptyTranscript();
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
    transcript,
    loading,
    error,
    isActive: chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false,
    needsSshCredentials: chat?.config.source?.kind === "ssh_server"
      && chat.state.connectionStatus === "needs_credentials",
    refreshChat,
    loadOlderEntries,
    loadToolCallDetails,
    applyChatSnapshot,
    markChatStarting,
    handleReconnect,
  };
}
