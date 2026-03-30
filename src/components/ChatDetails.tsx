import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { ConversationViewer } from "./LogViewer";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import { Button, StatusBadge } from "./common";
import { toMessageImageAttachments } from "../lib/image-attachments";
import { appFetch } from "../lib/public-path";
import { useMarkdownPreference, useToast, useWebSocket } from "../hooks";
import type {
  Chat,
  ChatEvent,
  ComposerImageAttachment,
  LoopLogEntry,
  MessageData,
  ToolCallData,
} from "../types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "interrupting", "reconnecting"]);

function getChatStatusLabel(status: Chat["state"]["status"]): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "streaming":
      return "Streaming";
    case "interrupting":
      return "Interrupting";
    case "reconnecting":
      return "Reconnecting";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function getChatStatusVariant(status: Chat["state"]["status"]): "default" | "success" | "warning" | "error" | "info" {
  switch (status) {
    case "streaming":
    case "starting":
    case "reconnecting":
      return "info";
    case "interrupting":
      return "warning";
    case "failed":
      return "error";
    case "idle":
      return "success";
    default:
      return "default";
  }
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const next = items.filter((entry) => entry.id !== item.id);
  next.push(item);
  return next.sort((left, right) => left.id.localeCompare(right.id));
}

function appendLog(logs: LoopLogEntry[], log: LoopLogEntry): LoopLogEntry[] {
  return [...logs, log].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function ChatDetails({
  chatId,
  onBack,
  showBackButton = true,
  headerOffsetClassName,
}: {
  chatId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  headerOffsetClassName?: string;
}) {
  const toast = useToast();
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const [chat, setChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReconnectPending, setIsReconnectPending] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const reconnectAttemptedRef = useRef(false);

  const refreshChat = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch(`/api/chats/${chatId}`);
      if (!response.ok) {
        if (response.status === 404) {
          setChat(null);
          setError("Chat not found");
          return;
        }
        throw new Error(await parseError(response, "Failed to fetch chat"));
      }
      const data = (await response.json()) as Chat;
      setChat(data);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.chatId !== chatId) {
      return;
    }
    setChat((current) => {
      if (!current) {
        return current;
      }
      switch (event.type) {
        case "chat.status":
          return {
            ...current,
            state: {
              ...current.state,
              status: event.status,
              lastActivityAt: event.timestamp,
            },
          };
        case "chat.message":
          return {
            ...current,
            state: {
              ...current.state,
              lastActivityAt: event.timestamp,
              messages: upsertById(current.state.messages as MessageData[], event.message),
            },
          };
        case "chat.tool_call":
          return {
            ...current,
            state: {
              ...current.state,
              lastActivityAt: event.timestamp,
              toolCalls: upsertById(current.state.toolCalls as ToolCallData[], event.tool),
            },
          };
        case "chat.log":
          return {
            ...current,
            state: {
              ...current.state,
              lastActivityAt: event.timestamp,
              logs: appendLog(current.state.logs, event.log),
            },
          };
        case "chat.interrupted":
          return {
            ...current,
            state: {
              ...current.state,
              status: "stopped",
              lastActivityAt: event.timestamp,
            },
          };
        case "chat.error":
          return {
            ...current,
            state: {
              ...current.state,
              status: "failed",
              error: {
                message: event.message,
                timestamp: event.timestamp,
              },
            },
          };
        case "chat.deleted":
          return null;
        default:
          return current;
      }
    });
  }, [chatId]);

  useWebSocket<ChatEvent>({
    url: `/api/ws?chatId=${encodeURIComponent(chatId)}`,
    onEvent: handleEvent,
  });

  useEffect(() => {
    void refreshChat();
  }, [refreshChat]);

  const isActive = chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false;

  const handleReconnect = useCallback(async (showSuccessToast = true) => {
    setIsReconnectPending(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}/reconnect`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to reconnect chat"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
      if (showSuccessToast) {
        toast.success("Chat reconnected");
      }
    } catch (reconnectError) {
      toast.error(String(reconnectError));
    } finally {
      setIsReconnectPending(false);
    }
  }, [chatId, toast]);

  useEffect(() => {
    if (!chat || reconnectAttemptedRef.current || !chat.state.session?.id) {
      return;
    }
    if (!ACTIVE_CHAT_STATUSES.has(chat.state.status)) {
      return;
    }
    reconnectAttemptedRef.current = true;
    void handleReconnect(false);
  }, [chat, handleReconnect]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chat || isActive || isSubmitting) {
      return;
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0 && attachments.length === 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage.length > 0 ? trimmedMessage : undefined,
          attachments: attachments.length > 0 ? toMessageImageAttachments(attachments) : undefined,
        }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to send chat message"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
      setMessage("");
      setAttachments([]);
    } catch (submitError) {
      toast.error(String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleInterrupt() {
    if (!chat || !isActive || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to interrupt chat"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
    } catch (interruptError) {
      toast.error(String(interruptError));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  const canReconnect = Boolean(chat?.state.session?.id) && !isActive;
  const transcriptDescription = useMemo(() => {
    if (!chat) {
      return "";
    }
    if (chat.state.worktree?.worktreePath) {
      return `${chat.config.directory} · ${chat.state.worktree.worktreePath}`;
    }
    return chat.config.directory;
  }, [chat]);

  if (loading) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chat) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className={`border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-neutral-900 ${headerOffsetClassName ?? ""}`}>
          <div className="flex items-center gap-3">
            {showBackButton && onBack && (
              <Button type="button" variant="ghost" size="sm" onClick={onBack}>
                Back
              </Button>
            )}
            <div>
              <h1 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Not found</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "Chat not found"}</p>
            </div>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-900">
      <header className={`border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-neutral-900 ${headerOffsetClassName ?? ""}`}>
        <div className="flex flex-wrap items-start gap-3">
          {showBackButton && onBack && (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              Back
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-gray-950 dark:text-gray-100">
                {chat.config.name}
              </h1>
              <StatusBadge variant={getChatStatusVariant(chat.state.status)}>
                {getChatStatusLabel(chat.state.status)}
              </StatusBadge>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{transcriptDescription}</p>
            {chat.state.worktree?.workingBranch && (
              <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400">
                {chat.state.worktree.workingBranch}
              </p>
            )}
            {chat.state.error && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {chat.state.error.message}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canReconnect && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleReconnect()}
                loading={isReconnectPending}
              >
                Reconnect
              </Button>
            )}
            {isActive && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleInterrupt()}
                loading={isSubmitting}
              >
                Interrupt
              </Button>
            )}
          </div>
        </div>
      </header>

      <ConversationViewer
        id="chat-transcript"
        messages={chat.state.messages}
        toolCalls={chat.state.toolCalls}
        logs={chat.state.logs}
        isActive={isActive}
        markdownEnabled={markdownEnabled}
        showAssistantMessages
        showMessageRoles
        showResponseLogs={isActive}
        emptyStateMessage="No messages yet"
        activeStateMessage="Thinking…"
      />

      <form onSubmit={handleSubmit} className="border-t border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-neutral-900">
        <label htmlFor="chat-message" className="sr-only">Message</label>
        <textarea
          id="chat-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={handlePaste}
          rows={3}
          placeholder={isActive ? "Wait for the current turn to finish…" : "Send a message to the agent…"}
          disabled={isActive || isSubmitting}
          className="block min-h-[96px] w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <ImageAttachmentControl
            ref={attachmentControlRef}
            attachments={attachments}
            onChange={setAttachments}
            disabled={isActive || isSubmitting}
            hint="Paste or attach images for the next turn."
          />
          <Button
            type="submit"
            size="sm"
            disabled={isActive || isSubmitting || (message.trim().length === 0 && attachments.length === 0)}
            loading={isSubmitting}
          >
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
