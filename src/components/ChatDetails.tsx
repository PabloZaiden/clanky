import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { ConversationViewer } from "./LogViewer";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import { RenameChatModal } from "./RenameChatModal";
import { Button, ConfirmModal, StatusBadge, getChatStatusBadgeVariant } from "./common";
import { ChatFocusModeBar } from "./chat-details/chat-focus-mode-bar";
import { useChatFocusMode } from "./chat-details/use-chat-focus-mode";
import { toMessageImageAttachments } from "../lib/image-attachments";
import { appFetch } from "../lib/public-path";
import { useMarkdownPreference, useToast, useWebSocket } from "../hooks";
import { mergeChatSnapshot } from "../utils/chat-snapshot";
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
  const next = logs.filter((entry) => entry.id !== log.id);
  next.push(log);
  return next.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function isCancellationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("request cancelled")
    || normalized.includes("operation cancelled by user")
    || normalized.includes("prompt cancelled")
    || normalized.includes("session cancelled")
    || normalized.includes("aborterror")
    || normalized.includes("useraborterror")
    || normalized.includes("-32800");
}

function isStaleTerminalEvent(chat: Chat, timestamp: string): boolean {
  const lastActivityAt = chat.state.lastActivityAt;
  return typeof lastActivityAt === "string" && lastActivityAt.localeCompare(timestamp) > 0;
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
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const reconnectAttemptedRef = useRef(false);
  const { isFocusMode, toggleFocusMode } = useChatFocusMode();

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
        case "chat.updated":
          return mergeChatSnapshot(current, event.chat);
        case "chat.status":
          if (isStaleTerminalEvent(current, event.timestamp) && ACTIVE_CHAT_STATUSES.has(current.state.status)) {
            return current;
          }
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
          if (isStaleTerminalEvent(current, event.timestamp) && ACTIVE_CHAT_STATUSES.has(current.state.status)) {
            return current;
          }
          return {
            ...current,
            state: {
              ...current.state,
              status: "idle",
              activeMessageId: undefined,
              lastActivityAt: event.timestamp,
            },
          };
        case "chat.error":
          if (
            isStaleTerminalEvent(current, event.timestamp)
            && ACTIVE_CHAT_STATUSES.has(current.state.status)
            && isCancellationMessage(event.message)
          ) {
            return current;
          }
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
    }
  }, [chatId, toast]);

  useEffect(() => {
    if (!chat || !chat.state.session?.id || !ACTIVE_CHAT_STATUSES.has(chat.state.status)) {
      reconnectAttemptedRef.current = false;
      return;
    }
    if (reconnectAttemptedRef.current) {
      return;
    }
    reconnectAttemptedRef.current = true;
    void handleReconnect(false);
  }, [chat, handleReconnect]);

  const handleRename = useCallback(async (newName: string) => {
    const response = await appFetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!response.ok) {
      throw new Error(await parseError(response, "Failed to rename chat"));
    }
    const updatedChat = (await response.json()) as Chat;
    setChat(updatedChat);
    toast.success(`Renamed chat to “${updatedChat.config.name}”`);
  }, [chatId, toast]);

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

  async function handleDelete() {
    if (isDeletePending) {
      return;
    }

    setIsDeletePending(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to delete chat"));
      }
      setIsDeleteConfirmOpen(false);
      toast.success("Chat deleted");
      onBack?.();
    } catch (deleteError) {
      toast.error(String(deleteError));
    } finally {
      setIsDeletePending(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composerFormRef.current?.requestSubmit();
    }
  }

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

  const hasPendingInput = message.trim().length > 0 || attachments.length > 0;
  const actionButtonBaseClassName = "flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md disabled:cursor-not-allowed";
  const sendButtonClassName = `${actionButtonBaseClassName} bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const interruptButtonClassName = `${actionButtonBaseClassName} bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-red-500 dark:text-white dark:hover:bg-red-400 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;

  const conversation = (
    <ConversationViewer
      id="chat-transcript"
      messages={chat.state.messages}
      toolCalls={chat.state.toolCalls}
      logs={chat.state.logs}
      autoScroll={autoScroll}
      isActive={isActive}
      markdownEnabled={markdownEnabled}
      showAssistantMessages
      showResponseLogs={isActive}
      emptyStateMessage="No messages yet"
      activeStateMessage="Thinking…"
    />
  );

  const composer = (
    <form
      ref={composerFormRef}
      onSubmit={handleSubmit}
      className={`border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-neutral-900 ${isFocusMode ? "" : "safe-area-bottom"}`}
    >
      <label htmlFor="chat-message" className="sr-only">Message</label>
      <div className="flex flex-row items-center gap-2 sm:gap-3">
        <input
          id="chat-message"
          type="text"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          onPaste={handlePaste}
          placeholder={isActive ? "Wait for the current turn to finish…" : "Send a message to the agent…"}
          disabled={isActive || isSubmitting}
          className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
        />
        <ImageAttachmentControl
          ref={attachmentControlRef}
          attachments={attachments}
          onChange={setAttachments}
          disabled={isActive || isSubmitting}
          iconOnly
        />
        {isActive ? (
          <button
            type="button"
            onClick={() => void handleInterrupt()}
            disabled={isSubmitting}
            className={interruptButtonClassName}
            aria-label="Interrupt"
            title="Interrupt"
          >
            {isSubmitting ? (
              <span className="animate-spin text-sm">⏳</span>
            ) : (
              <span className="text-lg leading-none">×</span>
            )}
          </button>
        ) : (
          <button
            type="submit"
            disabled={isSubmitting || !hasPendingInput}
            className={sendButtonClassName}
            aria-label="Send"
            title="Send"
          >
            {isSubmitting ? (
              <span className="animate-spin text-sm">⏳</span>
            ) : (
              <span className="text-lg leading-none">↑</span>
            )}
          </button>
        )}
      </div>
    </form>
  );

  const deleteConfirmModal = (
    <ConfirmModal
      isOpen={isDeleteConfirmOpen}
      onClose={() => setIsDeleteConfirmOpen(false)}
      onConfirm={() => void handleDelete()}
      title="Delete chat?"
      message="This removes the saved chat session, transcript, and any worktree created for it."
      confirmLabel="Delete"
      loading={isDeletePending}
    />
  );

  const renameModal = (
    <RenameChatModal
      isOpen={isRenameModalOpen}
      onClose={() => setIsRenameModalOpen(false)}
      currentName={chat.config.name}
      onRename={handleRename}
    />
  );

  if (isFocusMode) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#1e1e1e]">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-3">
          {chat.state.error && (
            <p className="mb-3 shrink-0 text-sm text-red-300">
              {chat.state.error.message}
            </p>
          )}
          {conversation}
        </div>
        {composer}
        <ChatFocusModeBar
          autoScroll={autoScroll}
          onAutoScrollChange={setAutoScroll}
          onExitFocusMode={toggleFocusMode}
          applySafeAreaBottom
        />
        {deleteConfirmModal}
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
              <StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>
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
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setIsRenameModalOpen(true)}
              disabled={isDeletePending}
            >
              Rename
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 w-9 px-0"
              onClick={toggleFocusMode}
              aria-label="Enter focus mode"
              title="Focus mode — fullscreen chat with compact controls"
            >
              <span aria-hidden="true" className="text-base leading-none">⤢</span>
            </Button>
            <Button
              type="button"
              variant="danger"
              size="xs"
              onClick={() => setIsDeleteConfirmOpen(true)}
              loading={isDeletePending}
              aria-label="Delete chat"
              title="Delete chat"
            >
              Delete
            </Button>
          </div>
        </div>
      </header>

      {conversation}
      {composer}
      {renameModal}
      {deleteConfirmModal}
    </div>
  );
}
