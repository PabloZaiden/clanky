import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ConversationViewer, type TranscriptFileLinkTarget } from "./LogViewer";
import {
  ImageAttachmentControl,
  ImageAttachmentPreviewList,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import {
  ComposerActionsMenu,
  ComposerActionsMenuButton,
  ComposerActionsMenuSection,
} from "./ComposerActionsMenu";
import {
  getModelDisplayName,
  isModelEnabled,
  makeModelKey,
  ModelSelector,
  parseModelKey,
} from "./ModelSelector";
import { ChatTemplateSelector } from "./chat-template-selector";
import {
  Button,
  FocusPreservingButton,
  useComposerSizing,
} from "./common";
import { MESSAGE_IMAGE_ATTACHMENT_LIMIT, toMessageImageAttachments } from "../lib/image-attachments";
import { appAbsoluteUrl, appFetch } from "../lib/public-path";
import { getStoredSshCredentialToken } from "../lib/ssh-browser-credentials";
import { useAvailableModels, useMarkdownPreference, useRealtimeStream, useToast } from "../hooks";
import { getStreamingActivityStatus, mergeChatSnapshot } from "../utils/chat-snapshot";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@/shared";
import { mergeToolCallRecord, upsertToolCallExtra } from "@/shared/tool-call";
import { DictationControls, insertDictationText } from "./dictation";
import type { Chat, ChatEvent, ComposerImageAttachment, TaskLogEntry, MessageData, ToolCallData } from "@/shared";
import { replaceWebAppRoute, routeToHash, useRealtimeRefresh, type WebAppRoute } from "@pablozaiden/webapp/web";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "interrupting", "reconnecting"]);

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertById<T extends { id: string; timestamp?: string }>(items: T[], item: T): T[] {
  const next = items.filter((entry) => entry.id !== item.id);
  next.push(item);
  return next.sort((left, right) => {
    const leftTimestamp = left.timestamp ?? "";
    const rightTimestamp = right.timestamp ?? "";
    const byTimestamp = leftTimestamp.localeCompare(rightTimestamp);
    return byTimestamp !== 0 ? byTimestamp : left.id.localeCompare(right.id);
  }).slice(-1000);
}

type ChatStreamEvent = Extract<
  ChatEvent,
  {
    type:
      | "chat.message"
      | "chat.message.delta"
      | "chat.tool_call"
      | "chat.tool_call.extra"
      | "chat.log"
      | "chat.log.delta";
  }
>;

export function ChatDetails({
  chatId,
  onBack,
  showBackButton = true,
  embeddedTaskId,
}: {
  chatId: string;
  onBack?: () => void;
  showBackButton?: boolean;
  embeddedTaskId?: string;
}) {
  const toast = useToast();
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const isEmbedded = typeof embeddedTaskId === "string" && embeddedTaskId.length > 0;
  const [chat, setChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDictationPopover, setShowDictationPopover] = useState(false);
  const [removingQueuedMessageIds, setRemovingQueuedMessageIds] = useState<string[]>([]);
  const [permissionReplyPendingIds, setPermissionReplyPendingIds] = useState<string[]>([]);
  const permissionReplyPendingIdsRef = useRef(new Set<string>());
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dictationPopoverRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressActivatedRef = useRef(false);
  const reconnectAttemptedRef = useRef(false);
  const { models, modelsLoading } = useAvailableModels({
    workspaceId: isEmbedded || chat?.config.source?.kind === "ssh_server" ? undefined : chat?.config.workspaceId,
  });

  const refreshChat = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    try {
      if (showLoading) {
        setLoading(true);
      }
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
      setChat((current) => current ? mergeChatSnapshot(current, data) : data);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [chatId]);

  const handleEvent = useCallback((event: ChatStreamEvent) => {
    if (event.chatId !== chatId) {
      return;
    }
    setChat((current) => {
      if (!current) {
        return current;
      }
      switch (event.type) {
        case "chat.message":
          return {
            ...current,
            state: {
              ...current.state,
              status: event.message.role === "assistant"
                ? getStreamingActivityStatus(current.state.status)
                : current.state.status,
              lastActivityAt: event.timestamp,
              messages: upsertById(current.state.messages as MessageData[], event.message),
            },
          };
        case "chat.message.delta": {
          const messages = current.state.messages as MessageData[];
          const existingIndex = messages.findIndex((messageEntry) => messageEntry.id === event.messageId);
          if (existingIndex < 0 && event.baseLength !== 0) {
            void refreshChat({ showLoading: false });
            return current;
          }
          if (existingIndex >= 0 && messages[existingIndex]!.content.length !== event.baseLength) {
            void refreshChat({ showLoading: false });
            return current;
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
          };
        }
        case "chat.tool_call":
          return {
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
          };
        case "chat.tool_call.extra":
          return {
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
          };
        case "chat.log":
          return {
            ...current,
            state: {
              ...current.state,
              status: getStreamingActivityStatus(current.state.status),
              lastActivityAt: event.timestamp,
              logs: upsertById(current.state.logs as TaskLogEntry[], event.log),
            },
          };
        case "chat.log.delta": {
          const logs = current.state.logs as TaskLogEntry[];
          const existingIndex = logs.findIndex((logEntry) => logEntry.id === event.logId);
          if (existingIndex < 0 && event.baseLength !== 0) {
            void refreshChat({ showLoading: false });
            return current;
          }
          const existingContent = existingIndex >= 0
            ? logs[existingIndex]!.details?.["responseContent"]
            : "";
          if (typeof existingContent !== "string" || existingContent.length !== event.baseLength) {
            void refreshChat();
            return current;
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
            ...current,
            state: {
              ...current.state,
              status: getStreamingActivityStatus(current.state.status),
              lastActivityAt: event.timestamp,
              logs: nextLogs,
            },
          };
        }
        default:
          return current;
      }
    });
  }, [chatId, refreshChat]);

  useRealtimeRefresh({
    resources: ["chats"],
    ids: [chatId],
    filters: { resource: "chats", id: chatId },
    refresh: (event) => {
      if (event.action === "deleted") {
        setChat(null);
        setError("Chat not found");
        return;
      }
      return refreshChat({ showLoading: false });
    },
  });

  const { status: chatSocketStatus } = useRealtimeStream<ChatStreamEvent>({
    filters: { chatId },
    predicate: (event) => event.type.startsWith("chat."),
    onEvent: handleEvent,
    onReconnect: () => refreshChat({ showLoading: false }),
  });

  useEffect(() => {
    void refreshChat();
  }, [refreshChat]);

  useEffect(() => {
    setSelectedModel("");
  }, [chat?.config.model.modelID, chat?.config.model.providerID, chat?.config.model.variant]);

  const isActive = chat ? ACTIVE_CHAT_STATUSES.has(chat.state.status) : false;
  const currentModelKey = chat
    ? makeModelKey(chat.config.model.providerID, chat.config.model.modelID, chat.config.model.variant)
    : "";
  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : true;
  const needsSshCredentials = chat?.config.source?.kind === "ssh_server"
    && chat.state.connectionStatus === "needs_credentials";

  const handleReconnect = useCallback(async () => {
    try {
      const credentialToken = chat?.config.source?.kind === "ssh_server"
        ? await getStoredSshCredentialToken(chat.config.source.sshServerId)
        : null;
      const response = await appFetch(`/api/chats/${chatId}/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentialToken ? { credentialToken } : {}),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to reconnect chat"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
    } catch (reconnectError) {
      toast.error(String(reconnectError));
    }
  }, [chat, chatId, toast]);

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

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showDictationPopover) {
      return;
    }
    function handleDocumentPointerDown(event: globalThis.PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node) || dictationPopoverRef.current?.contains(target)) {
        return;
      }
      setShowDictationPopover(false);
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [showDictationPopover]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chat || isSubmitting) {
      return;
    }

    const trimmedMessage = message.trim();
    const queueableInputPresent = trimmedMessage.length > 0 || attachments.length > 0;
    const hasPendingModelChange = !isEmbedded && !isActive && selectedModel.length > 0;
    if (isActive && !queueableInputPresent) {
      return;
    }
    if (trimmedMessage.length === 0 && attachments.length === 0 && !hasPendingModelChange) {
      return;
    }

    if (hasPendingModelChange && !selectedModelEnabled) {
      toast.error("The selected model's provider is not connected. Please select a different model.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (hasPendingModelChange) {
        const parsedModel = parseModelKey(selectedModel);
        if (!parsedModel) {
          throw new Error("Failed to parse selected model");
        }

        const updateResponse = await appFetch(`/api/chats/${chatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
              variant: parsedModel.variant,
            },
          }),
        });
        if (!updateResponse.ok) {
          throw new Error(await parseError(updateResponse, "Failed to update chat model"));
        }
        const updatedChat = (await updateResponse.json()) as Chat;
        setChat(updatedChat);
        setSelectedModel("");
      }

      if (trimmedMessage.length === 0 && attachments.length === 0) {
        return;
      }

      const response = await appFetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage.length > 0 ? trimmedMessage : null,
          attachments: attachments.length > 0 ? toMessageImageAttachments(attachments) : [],
        }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to send chat message"));
      }
      const data = (await response.json()) as { chat?: Chat };
      if (data.chat) {
        setChat(data.chat);
      } else if (isActive) {
        await refreshChat();
      } else if (!isActive) {
        setChat((current) => current
          ? {
              ...current,
              state: {
                ...current.state,
                status: "starting",
                error: undefined,
                activeMessageId: undefined,
                interruptRequested: false,
              },
            }
          : current);
      }
      setMessage("");
      setSelectedTemplate("");
      setAttachments([]);
      setAttachmentError(null);
    } catch (submitError) {
      toast.error(String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRemoveQueuedMessage(queuedMessageId: string): Promise<void> {
    if (removingQueuedMessageIds.includes(queuedMessageId)) {
      return;
    }

    setRemovingQueuedMessageIds((current) => [...current, queuedMessageId]);
    try {
      const response = await appFetch(`/api/chats/${chatId}/queued-messages/${encodeURIComponent(queuedMessageId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to remove queued message"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
    } catch (removeError) {
      toast.error(getErrorMessage(removeError));
    } finally {
      setRemovingQueuedMessageIds((current) => current.filter((id) => id !== queuedMessageId));
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
        body: JSON.stringify({ reason: DEFAULT_CHAT_INTERRUPT_REASON }),
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

  async function handlePermissionReply(requestId: string, decision: "allow" | "deny"): Promise<void> {
    if (permissionReplyPendingIdsRef.current.has(requestId)) {
      return;
    }

    permissionReplyPendingIdsRef.current.add(requestId);
    setPermissionReplyPendingIds((current) => [...current, requestId]);
    try {
      const response = await appFetch(`/api/chats/${chatId}/permissions/${encodeURIComponent(requestId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to reply to permission request"));
      }
      const nextChat = (await response.json()) as Chat;
      setChat(nextChat);
    } catch (permissionError) {
      toast.error(getErrorMessage(permissionError));
    } finally {
      permissionReplyPendingIdsRef.current.delete(requestId);
      setPermissionReplyPendingIds((current) => current.filter((id) => id !== requestId));
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composerFormRef.current?.requestSubmit();
    }
  }

  const chatWorkingDirectory = chat?.state.worktree?.worktreePath ?? chat?.config.directory ?? "";
  const fileLinkContext = useMemo(() => {
    if (!chat || !chatWorkingDirectory) {
      return undefined;
    }

    const getCodeExplorerRoute = ({ path, startDirectory, kind }: TranscriptFileLinkTarget): WebAppRoute => (
      embeddedTaskId
        ? {
            view: "code-explorer",
            contentType: "task",
            taskId: embeddedTaskId,
            startDirectory,
            filePath: kind === "directory" ? undefined : path,
          }
        : {
            view: "code-explorer",
            contentType: "chat",
            chatId: chat.config.id,
            startDirectory,
            filePath: kind === "directory" ? undefined : path,
          }
    );

    return {
      fileExplorerTarget: {
        type: "workspace" as const,
        id: chat.config.workspaceId,
        startDirectory: chatWorkingDirectory,
      },
      rootDirectory: chatWorkingDirectory,
      getFileHref: (target: TranscriptFileLinkTarget) => appAbsoluteUrl(routeToHash(getCodeExplorerRoute(target))),
      openFile: (target: TranscriptFileLinkTarget) => {
        replaceWebAppRoute(getCodeExplorerRoute(target));
      },
      onFileOpenError: (message: string) => {
        toast.error(message);
      },
    };
  }, [chat, chatWorkingDirectory, embeddedTaskId, toast]);

  const {
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
  } = useComposerSizing(message);
  const composerInstanceId = useId();

  if (loading && !chat) {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>;
  }

  if (!chat) {
    if (isEmbedded) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            {error ?? "Chat not found"}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="p-6">
          {showBackButton && onBack && (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              ← Back
            </Button>
          )}
          <div className="mt-4 min-w-0">
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Not found</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "Chat not found"}</p>
          </div>
        </div>
      </div>
    );
  }

  const hasQueueableInput = message.trim().length > 0 || attachments.length > 0;
  const hasPendingInput = hasQueueableInput || (!isEmbedded && selectedModel.length > 0);
  const toolPathDisplayRoot = chatWorkingDirectory;
  const actionButtonBaseClassName = "flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md disabled:cursor-not-allowed";
  const sendButtonClassName = `${actionButtonBaseClassName} bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const interruptButtonClassName = `${actionButtonBaseClassName} bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-red-500 dark:text-white dark:hover:bg-red-400 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const modelSelectId = `${composerInstanceId}-chat-model`;
  const messageInputId = `${composerInstanceId}-chat-message`;
  const secondaryActionsDisabled = isSubmitting || needsSshCredentials;
  const attachmentLimitReached = attachments.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT;
  const hasPendingComposerActions = attachments.length > 0 || selectedTemplate.length > 0 || (!isEmbedded && selectedModel.length > 0);
  const queuedMessages = chat.state.queuedMessages ?? [];

  function handleDictationTranscript(transcript: string): void {
    const insertion = insertDictationText(
      message,
      transcript,
      composerTextareaRef.current?.selectionStart,
      composerTextareaRef.current?.selectionEnd,
    );
    setMessage(insertion.value);
    setShowDictationPopover(false);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(insertion.caretPosition, insertion.caretPosition);
    });
  }

  function clearLongPressTimer(): void {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleSendPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0 || isSubmitting || needsSshCredentials) {
      return;
    }
    longPressActivatedRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressActivatedRef.current = true;
      setShowDictationPopover(true);
    }, 450);
  }

  function handleSendPointerEnd(): void {
    clearLongPressTimer();
  }

  function handleSendClick(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    if (longPressActivatedRef.current) {
      event.stopPropagation();
      longPressActivatedRef.current = false;
      return;
    }
    if ((isActive ? hasQueueableInput : hasPendingInput) && (!isActive || selectedModel.length === 0 || selectedModelEnabled)) {
      composerFormRef.current?.requestSubmit();
      return;
    }
    setShowDictationPopover(true);
  }

  const conversation = (
    <ConversationViewer
      id="chat-transcript"
      messages={chat.state.messages}
      toolCalls={chat.state.toolCalls}
      logs={chat.state.logs}
      isActive={isActive}
      activeMessageId={chat.state.activeMessageId}
      markdownEnabled={markdownEnabled}
      showAssistantMessages
      showResponseLogs={false}
      toolPathDisplayRoot={toolPathDisplayRoot}
      fileLinkContext={fileLinkContext}
      emptyStateMessage="No messages yet"
      activeStateMessage="Thinking…"
    />
  );
  const pendingPermissionRequests = (chat.state.pendingPermissionRequests ?? []).filter(
    (permissionRequest) => permissionRequest.status === "pending",
  );
  const permissionApprovalPanel = pendingPermissionRequests.length > 0 && (
    <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/30">
      <div className="mx-auto max-w-4xl space-y-3">
        {pendingPermissionRequests.map((permissionRequest) => {
          const isReplying = permissionReplyPendingIds.includes(permissionRequest.requestId);
          return (
            <div
              key={permissionRequest.requestId}
              className="rounded-md border border-amber-200 bg-white p-3 shadow-sm dark:border-amber-900/70 dark:bg-neutral-900"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    Provider requests permission: {permissionRequest.permission}
                  </p>
                  {permissionRequest.patterns.length > 0 && (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-amber-100 p-2 font-mono text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
                      {permissionRequest.patterns.join("\n")}
                    </pre>
                  )}
                  {permissionRequest.error && (
                    <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                      {permissionRequest.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void handlePermissionReply(permissionRequest.requestId, "deny")}
                    disabled={isReplying}
                  >
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handlePermissionReply(permissionRequest.requestId, "allow")}
                    disabled={isReplying}
                    loading={isReplying}
                  >
                    Allow
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
  const queuedMessagesPanel = queuedMessages.length > 0 && (
    <div className="px-4 py-3">
      <div className="mx-auto max-w-4xl space-y-2">
        {queuedMessages.map((queuedMessage, index) => {
          const isRemoving = removingQueuedMessageIds.includes(queuedMessage.id);
          const attachmentCount = queuedMessage.attachments?.length ?? 0;
          return (
            <div
              key={queuedMessage.id}
              className="relative rounded-md border border-dashed border-amber-300 bg-white px-3 py-2 pr-10 text-sm shadow-sm dark:border-amber-800/80 dark:bg-neutral-900"
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                <span>Queue #{index + 1}</span>
                {attachmentCount > 0 && (
                  <span>{attachmentCount} image{attachmentCount === 1 ? "" : "s"}</span>
                )}
              </div>
              {queuedMessage.content.trim().length > 0 && (
                <p className="whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">
                  {queuedMessage.content}
                </p>
              )}
              <button
                type="button"
                onClick={() => void handleRemoveQueuedMessage(queuedMessage.id)}
                disabled={isRemoving}
                className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-neutral-800 dark:hover:text-gray-100"
                aria-label="Remove queued message"
                title="Remove queued message"
              >
                <span className="text-base leading-none">×</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const composer = (
    <form
      ref={composerFormRef}
      onSubmit={handleSubmit}
      className="safe-area-bottom border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900"
    >
      <div className="p-3" data-testid="chat-composer-padding">
        <label htmlFor={modelSelectId} className="sr-only">Model</label>
        <label htmlFor={messageInputId} className="sr-only">Message</label>
        <div className="space-y-2" data-testid="chat-composer-layout">
          {needsSshCredentials && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              <span>This remote chat needs SSH credentials before messages can be sent.</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void handleReconnect()}>
                Reconnect
              </Button>
            </div>
          )}
          <div className="flex min-w-0 items-end gap-2 sm:gap-3" data-testid="chat-composer-main-row">
            <ComposerActionsMenu
              ariaLabel="Message actions"
              disabled={secondaryActionsDisabled}
              hasPendingActions={hasPendingComposerActions}
            >
              <ComposerActionsMenuSection label="Template">
                <ChatTemplateSelector
                  selectedTemplate={selectedTemplate}
                  onChange={setSelectedTemplate}
                  onPromptChange={setMessage}
                  disabled={secondaryActionsDisabled}
                />
              </ComposerActionsMenuSection>
              {!isEmbedded && (
                <ComposerActionsMenuSection label="Model">
                  <ModelSelector
                    id={modelSelectId}
                    value={selectedModel}
                    onChange={setSelectedModel}
                    models={models}
                    loading={modelsLoading}
                    disabled={secondaryActionsDisabled || isActive}
                    showDisconnected
                    currentModelKey={currentModelKey}
                    variantDiscovery={chat ? {
                      workspaceId: chat.config.workspaceId,
                    } : undefined}
                    placeholder={currentModelKey ? getModelDisplayName(models, currentModelKey) : "Select model..."}
                    loadingText="Loading..."
                    emptyText="No models available"
                    className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
                  />
                </ComposerActionsMenuSection>
              )}
              <ComposerActionsMenuSection label="Attachments">
                <ComposerActionsMenuButton
                  disabled={secondaryActionsDisabled || attachmentLimitReached}
                  onClick={() => attachmentControlRef.current?.openFilePicker()}
                >
                  <span>{attachmentLimitReached ? "Image limit reached" : "Attach image"}</span>
                  <span aria-hidden="true">📎</span>
                </ComposerActionsMenuButton>
              </ComposerActionsMenuSection>
            </ComposerActionsMenu>
            <textarea
              ref={(node) => {
                composerTextareaRef.current = node;
                composerRef(node);
              }}
              id={messageInputId}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              disabled={isSubmitting || needsSshCredentials}
              rows={composerRows}
              className={`${composerMinHeightClass} ${composerPaddingClass} min-w-0 w-full flex-1 resize-y rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600`}
            />
            {isActive && !hasQueueableInput ? (
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
              <div ref={dictationPopoverRef} className="relative flex-shrink-0">
                {showDictationPopover && (
                  <div className="absolute bottom-full right-0 z-20 mb-2 w-max max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-neutral-900">
                    <DictationControls
                      onTranscript={handleDictationTranscript}
                      onError={(dictationError) => toast.error(dictationError)}
                      disabled={isSubmitting || needsSshCredentials}
                    />
                  </div>
                )}
                <FocusPreservingButton
                  type="button"
                  disabled={isSubmitting || needsSshCredentials || (!isActive && selectedModel.length > 0 && !selectedModelEnabled)}
                  className={sendButtonClassName}
                  aria-label={isActive ? "Queue message" : "Send"}
                  title={`${isActive ? "Queue message" : "Send"} (hold for dictation)`}
                  onPointerDown={handleSendPointerDown}
                  onPointerUp={handleSendPointerEnd}
                  onPointerCancel={handleSendPointerEnd}
                  onPointerLeave={handleSendPointerEnd}
                  onClick={handleSendClick}
                >
                  {isSubmitting ? (
                    <span className="animate-spin text-sm">⏳</span>
                  ) : (
                    <span className="text-lg leading-none">↑</span>
                  )}
                </FocusPreservingButton>
              </div>
            )}
          </div>
          <ImageAttachmentControl
            ref={attachmentControlRef}
            attachments={attachments}
            onChange={setAttachments}
            disabled={secondaryActionsDisabled}
            iconOnly
            showTrigger={false}
            showPreviewList={false}
            showErrorText={false}
            onErrorChange={setAttachmentError}
          />
          {attachments.length > 0 && (
            <div className="min-w-0" data-testid="chat-composer-attachments-row">
              <ImageAttachmentPreviewList
                attachments={attachments}
                onRemoveAttachment={(attachmentId) => {
                  setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
                  setAttachmentError(null);
                }}
                disabled={isSubmitting}
              />
            </div>
          )}
        </div>
        {attachmentError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            {attachmentError}
          </p>
        )}
        {!isEmbedded && selectedModel && !selectedModelEnabled && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            The selected model's provider is not connected. Please select a different model.
          </p>
        )}
      </div>
    </form>
  );

  return (
    <div className={`flex h-full min-h-0 flex-col bg-white ${isEmbedded ? "dark:bg-neutral-800" : "dark:bg-neutral-900"}`}>
      {chat.state.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {chat.state.error.message}
        </div>
      )}

      {conversation}
      {permissionApprovalPanel}
      {queuedMessagesPanel}
      {composer}
    </div>
  );
}
