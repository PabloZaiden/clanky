import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
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
import { RenameChatModal } from "./RenameChatModal";
import { SpawnCurrentPlanModal } from "./SpawnCurrentPlanModal";
import { ChatTemplateSelector } from "./chat-template-selector";
import {
  ActionMenu,
  Button,
  ConfirmModal,
  FocusPreservingButton,
  StatusBadge,
  getChatStatusBadgeVariant,
  useComposerSizing,
} from "./common";
import { MESSAGE_IMAGE_ATTACHMENT_LIMIT, toMessageImageAttachments } from "../lib/image-attachments";
import { appAbsoluteUrl, appFetch } from "../lib/public-path";
import { getStoredSshCredentialToken } from "../lib/ssh-browser-credentials";
import { isChatEvent, useAppEvents, useAvailableModels, useMarkdownPreference, useToast } from "../hooks";
import { getStreamingActivityStatus, mergeChatSnapshot } from "../utils/chat-snapshot";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "../types";
import { mergeToolCallRecord, upsertToolCallExtra } from "../types/tool-call";
import { getHashForShellRoute, replaceShellRoute } from "./app-shell/shell-navigation";
import type { SidebarPinningState } from "./app-shell/sidebar-pins";
import { buildChatActionItems } from "./app-shell/shell-action-items";
import type {
  Chat,
  ChatEvent,
  ComposerImageAttachment,
  Task,
  TaskLogEntry,
  MessageData,
  ToolCallData,
} from "../types";

const ACTIVE_CHAT_STATUSES = new Set(["starting", "streaming", "interrupting", "reconnecting"]);
const TERMINAL_CHAT_STATUSES = new Set(["idle", "stopped", "failed"]);

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
  });
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
  onOpenCodeExplorer,
  onOpenTask,
  showBackButton = true,
  headerOffsetClassName,
  embeddedTaskId,
  sidebarPinning,
}: {
  chatId: string;
  onBack?: () => void;
  onOpenCodeExplorer?: (chatId: string) => void;
  onOpenTask?: (taskId: string) => void;
  showBackButton?: boolean;
  headerOffsetClassName?: string;
  embeddedTaskId?: string;
  sidebarPinning?: SidebarPinningState;
}) {
  const toast = useToast();
  const { enabled: markdownEnabled } = useMarkdownPreference();
  const isEmbedded = typeof embeddedTaskId === "string" && embeddedTaskId.length > 0;
  const chatHeaderClassName = "border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-neutral-800 flex-shrink-0 safe-area-top";
  const chatHeaderInnerClassName = "px-4 sm:px-6 lg:px-8 py-2";
  const chatHeaderPrimaryRowClassName = [(headerOffsetClassName ?? "ml-14 sm:ml-16 lg:ml-0"), "flex min-h-14 items-center gap-2"].join(" ");
  const [chat, setChat] = useState<Chat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSpawnPending, setIsSpawnPending] = useState(false);
  const [isSpawnCurrentPlanPending, setIsSpawnCurrentPlanPending] = useState(false);
  const [isSpawnCurrentPlanModalOpen, setIsSpawnCurrentPlanModalOpen] = useState(false);
  const [spawnCurrentPlanPath, setSpawnCurrentPlanPath] = useState("");
  const [isDeletePending, setIsDeletePending] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false);
  const [permissionReplyPendingIds, setPermissionReplyPendingIds] = useState<string[]>([]);
  const permissionReplyPendingIdsRef = useRef(new Set<string>());
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const reconnectAttemptedRef = useRef(false);
  const { models, modelsLoading } = useAvailableModels({
    directory: isEmbedded ? undefined : chat?.config.directory,
    workspaceId: isEmbedded || chat?.config.source?.kind === "ssh_server" ? undefined : chat?.config.workspaceId,
  });

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
      setChat((current) => current ? mergeChatSnapshot(current, data) : data);
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
          if (
            isStaleTerminalEvent(current, event.timestamp)
            && ACTIVE_CHAT_STATUSES.has(current.state.status)
            && !TERMINAL_CHAT_STATUSES.has(event.status)
          ) {
            return current;
          }
          return {
            ...current,
            state: {
              ...current.state,
              status: event.status,
              activeMessageId: TERMINAL_CHAT_STATUSES.has(event.status) ? undefined : current.state.activeMessageId,
              lastActivityAt: event.timestamp,
            },
          };
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
        case "chat.interrupted":
          if (isStaleTerminalEvent(current, event.timestamp)) {
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

  const { status: chatSocketStatus } = useAppEvents<ChatEvent>(handleEvent, isChatEvent);

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
  }, [chatId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chat || isActive || isSubmitting) {
      return;
    }

    const trimmedMessage = message.trim();
    const hasPendingModelChange = !isEmbedded && selectedModel.length > 0;
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
      onBack?.();
    } catch (deleteError) {
      toast.error(String(deleteError));
    } finally {
      setIsDeletePending(false);
    }
  }

  const handleSpawnTask = useCallback(async () => {
    if (!chat || isActive || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    setIsSpawnPending(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}/spawn-task`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to spawn task"));
      }
      const task = (await response.json()) as Task;
      onOpenTask?.(task.config.id);
    } catch (spawnError) {
      toast.error(String(spawnError));
    } finally {
      setIsSpawnPending(false);
    }
  }, [chat, chatId, isActive, isSpawnCurrentPlanPending, isSpawnPending, onOpenTask, toast]);

  const openSpawnCurrentPlanModal = useCallback(() => {
    if (!chat || isActive || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    setSpawnCurrentPlanPath("");
    setIsSpawnCurrentPlanModalOpen(true);
  }, [chat, isActive, isSpawnCurrentPlanPending, isSpawnPending]);

  const closeSpawnCurrentPlanModal = useCallback(() => {
    if (isSpawnCurrentPlanPending) {
      return;
    }

    setIsSpawnCurrentPlanModalOpen(false);
    setSpawnCurrentPlanPath("");
  }, [isSpawnCurrentPlanPending]);

  const handleSpawnTaskFromCurrentPlan = useCallback(async (requestedPlanPath: string) => {
    if (!chat || isActive || isSpawnPending || isSpawnCurrentPlanPending) {
      return;
    }

    const trimmedPlanPath = requestedPlanPath.trim();

    setIsSpawnCurrentPlanPending(true);
    try {
      const response = await appFetch(`/api/chats/${chatId}/spawn-task-from-current-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(trimmedPlanPath ? { planFilePath: trimmedPlanPath } : {}),
      });
      if (!response.ok) {
        throw new Error(await parseError(response, "Failed to spawn task from current plan"));
      }
      const task = (await response.json()) as Task;
      setSpawnCurrentPlanPath("");
      setIsSpawnCurrentPlanModalOpen(false);
      onOpenTask?.(task.config.id);
    } catch (spawnError) {
      toast.error(getErrorMessage(spawnError));
    } finally {
      setIsSpawnCurrentPlanPending(false);
    }
  }, [chat, chatId, isActive, isSpawnCurrentPlanPending, isSpawnPending, onOpenTask, toast]);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composerFormRef.current?.requestSubmit();
    }
  }

  const hasCodeExplorerAction = Boolean(onOpenCodeExplorer) && !isEmbedded;
  const chatWorkingDirectory = chat?.state.worktree?.worktreePath ?? chat?.config.directory ?? "";
  const fileLinkContext = useMemo(() => {
    if (!chat || !chatWorkingDirectory) {
      return undefined;
    }

    return {
      fileExplorerTarget: {
        type: "workspace" as const,
        id: chat.config.workspaceId,
        startDirectory: chatWorkingDirectory,
      },
      rootDirectory: chatWorkingDirectory,
      getFileHref: ({ path, startDirectory }: TranscriptFileLinkTarget) => `#${getHashForShellRoute({
        view: "code-explorer",
        target: embeddedTaskId
          ? {
              contentType: "task",
              taskId: embeddedTaskId,
              startDirectory,
              filePath: path,
            }
          : {
              contentType: "chat",
              chatId: chat.config.id,
              startDirectory,
              filePath: path,
            },
      })}`,
      openFile: ({ path, startDirectory }: TranscriptFileLinkTarget) => {
        replaceShellRoute({
          view: "code-explorer",
          target: embeddedTaskId
            ? {
                contentType: "task",
                taskId: embeddedTaskId,
                startDirectory,
                filePath: path,
              }
            : {
                contentType: "chat",
                chatId: chat.config.id,
                startDirectory,
                filePath: path,
              },
        });
      },
      onFileOpenError: (message: string) => {
        toast.error(message);
      },
    };
  }, [chat, chatWorkingDirectory, embeddedTaskId, toast]);

  const headerActionMenuItems = useMemo(() => {
    if (!chat || isEmbedded) {
      return [];
    }

    return buildChatActionItems({
      chat,
      hasCodeExplorerAction,
      spawnPending: isSpawnPending,
      spawnCurrentPlanPending: isSpawnCurrentPlanPending,
      onSpawnTask: () => void handleSpawnTask(),
      onSpawnTaskFromCurrentPlan: () => void openSpawnCurrentPlanModal(),
      onOpenCodeExplorer: () => onOpenCodeExplorer?.(chat.config.id),
      onViewTranscript: () => window.open(
        appAbsoluteUrl(`/#/chat-transcript/${encodeURIComponent(chat.config.id)}`),
        "_blank",
        "noopener,noreferrer",
      ),
      onDownloadTranscript: () => window.open(
        appAbsoluteUrl(`/api/chats/${encodeURIComponent(chat.config.id)}/transcript.md?download=1`),
        "_blank",
        "noopener,noreferrer",
      ),
      onRename: () => setIsRenameModalOpen(true),
      onDelete: () => setIsDeleteConfirmOpen(true),
      sidebarPinning,
    });
  }, [chat, handleSpawnTask, hasCodeExplorerAction, isActive, isEmbedded, isSpawnCurrentPlanPending, isSpawnPending, onOpenCodeExplorer, openSpawnCurrentPlanModal, sidebarPinning]);

  const {
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
  } = useComposerSizing(message);
  const composerInstanceId = useId();

  if (loading) {
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
        <header
          data-testid="chat-header"
          className={chatHeaderClassName}
        >
          <div className={chatHeaderInnerClassName}>
            <div
              data-testid="chat-header-primary-row"
              className={chatHeaderPrimaryRowClassName}
            >
              {showBackButton && onBack && (
                <Button type="button" variant="ghost" size="sm" onClick={onBack}>
                  ← Back
                </Button>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Not found</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{error ?? "Chat not found"}</p>
              </div>
            </div>
          </div>
        </header>
      </div>
    );
  }

  const hasPendingInput = message.trim().length > 0 || attachments.length > 0 || (!isEmbedded && selectedModel.length > 0);
  const toolPathDisplayRoot = chatWorkingDirectory;
  const actionButtonBaseClassName = "flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md disabled:cursor-not-allowed";
  const sendButtonClassName = `${actionButtonBaseClassName} bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const interruptButtonClassName = `${actionButtonBaseClassName} bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-red-500 dark:text-white dark:hover:bg-red-400 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const modelSelectId = `${composerInstanceId}-chat-model`;
  const messageInputId = `${composerInstanceId}-chat-message`;
  const secondaryActionsDisabled = isActive || isSubmitting || needsSshCredentials;
  const attachmentLimitReached = attachments.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT;
  const hasPendingComposerActions = attachments.length > 0 || selectedTemplate.length > 0 || (!isEmbedded && selectedModel.length > 0);
  const conversation = (
    <ConversationViewer
      id="chat-transcript"
      messages={chat.state.messages}
      toolCalls={chat.state.toolCalls}
      logs={chat.state.logs}
      isActive={isActive}
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
                    disabled={secondaryActionsDisabled}
                    showDisconnected
                    currentModelKey={currentModelKey}
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
              ref={composerRef}
              id={messageInputId}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              disabled={isSubmitting || needsSshCredentials}
              rows={composerRows}
              className={`${composerMinHeightClass} ${composerPaddingClass} min-w-0 w-full flex-1 resize-y rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600`}
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
              <FocusPreservingButton
                type="submit"
                disabled={isSubmitting || needsSshCredentials || !hasPendingInput || (selectedModel.length > 0 && !selectedModelEnabled)}
                className={sendButtonClassName}
                aria-label="Send"
                title="Send"
              >
                {isSubmitting ? (
                  <span className="animate-spin text-sm">⏳</span>
                ) : (
                  <span className="text-lg leading-none">↑</span>
                )}
              </FocusPreservingButton>
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
                disabled={isActive || isSubmitting}
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

  const spawnCurrentPlanModal = (
    <SpawnCurrentPlanModal
      isOpen={isSpawnCurrentPlanModalOpen}
      submitting={isSpawnCurrentPlanPending}
      initialPlanFilePath={spawnCurrentPlanPath}
      onClose={closeSpawnCurrentPlanModal}
      onSubmit={async (planFilePath) => {
        setSpawnCurrentPlanPath(planFilePath);
        await handleSpawnTaskFromCurrentPlan(planFilePath);
      }}
    />
  );

  return (
    <div className={`flex h-full min-h-0 flex-col bg-white ${isEmbedded ? "dark:bg-neutral-800" : "dark:bg-neutral-900"}`}>
      {!isEmbedded && (
        <header
          data-testid="chat-header"
          className={chatHeaderClassName}
        >
          <div className={chatHeaderInnerClassName}>
            <div
              data-testid="chat-header-primary-row"
              className={chatHeaderPrimaryRowClassName}
            >
              {showBackButton && onBack && (
                <Button type="button" variant="ghost" size="sm" onClick={onBack}>
                  ← Back
                </Button>
              )}
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-gray-900 dark:text-gray-100" title={chat.config.name}>
                  {chat.config.name}
                </h1>
                <StatusBadge
                  variant={getChatStatusBadgeVariant(chat.state.status)}
                  size="sm"
                  className="shrink-0"
                >
                  {getChatStatusLabel(chat.state.status)}
                </StatusBadge>
              </div>
              <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
                <div data-testid="chat-header-actions">
                  <ActionMenu
                    items={headerActionMenuItems}
                    ariaLabel="Chat actions"
                    disabled={isDeletePending}
                  />
                </div>
              </div>
            </div>
          </div>
        </header>
      )}

      {chat.state.error && (
        <div className="mx-4 mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
          {chat.state.error.message}
        </div>
      )}

      {conversation}
      {permissionApprovalPanel}
      {composer}
      {!isEmbedded && renameModal}
      {!isEmbedded && spawnCurrentPlanModal}
      {!isEmbedded && deleteConfirmModal}
    </div>
  );
}
