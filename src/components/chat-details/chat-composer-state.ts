import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  isModelEnabled,
  makeModelKey,
  parseModelKey,
} from "../ModelSelector";
import type { ImageAttachmentControlHandle } from "../ImageAttachmentControl";
import {
  isVisualViewportReduced,
  useComposerSizing,
  useVisualViewport,
} from "../common";
import { insertDictationText } from "../dictation";
import { useAvailableModels } from "../../hooks";
import {
  MESSAGE_ATTACHMENT_LIMIT,
  toMessageAttachments,
} from "../../lib/image-attachments";
import { appFetch } from "../../lib/public-path";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@/shared";
import type { Chat, ComposerAttachment } from "@/shared";
import { getChatErrorMessage, parseChatError } from "./chat-lifecycle";
import type { ChatComposerProps } from "./types";
import { useToast } from "@pablozaiden/webapp/web";

export function useChatComposer({
  chat,
  chatId,
  isEmbedded,
  isActive,
  needsSshCredentials,
  onChatSnapshot,
  markChatStarting,
  refreshChat,
}: ChatComposerProps) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDictationPopover, setShowDictationPopover] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dictationPopoverRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressActivatedRef = useRef(false);
  const visualViewport = useVisualViewport(true);
  const isKeyboardVisible = isVisualViewportReduced(
    visualViewport,
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  const { models, modelsLoading } = useAvailableModels({
    workspaceId: isEmbedded || chat.config.source?.kind === "ssh_server"
      ? undefined
      : chat.config.workspaceId,
  });

  useEffect(() => {
    setSelectedModel("");
  }, [chat.config.model.modelID, chat.config.model.providerID, chat.config.model.variant]);

  const currentModelKey = makeModelKey(
    chat.config.model.providerID,
    chat.config.model.modelID,
    chat.config.model.variant,
  );
  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : true;

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting) {
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
          throw new Error(await parseChatError(updateResponse, "Failed to update chat model"));
        }
        const updatedChat = (await updateResponse.json()) as Chat;
        onChatSnapshot(updatedChat);
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
          attachments: attachments.length > 0 ? toMessageAttachments(attachments) : [],
        }),
      });
      if (!response.ok) {
        throw new Error(await parseChatError(response, "Failed to send chat message"));
      }
      const data = (await response.json()) as { chat?: Chat };
      if (data.chat) {
        onChatSnapshot(data.chat);
      } else if (isActive) {
        await refreshChat();
      } else {
        markChatStarting();
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

  async function handleInterrupt(): Promise<void> {
    if (!isActive || isSubmitting) {
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
        throw new Error(await parseChatError(response, "Failed to interrupt chat"));
      }
      const nextChat = (await response.json()) as Chat;
      onChatSnapshot(nextChat);
    } catch (interruptError) {
      toast.error(getChatErrorMessage(interruptError));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    attachmentControlRef.current?.handlePaste(event);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composerFormRef.current?.requestSubmit();
    }
  }

  const {
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
  } = useComposerSizing(message);
  const composerInstanceId = useId();
  const hasQueueableInput = message.trim().length > 0 || attachments.length > 0;
  const hasPendingInput = hasQueueableInput || (!isEmbedded && selectedModel.length > 0);
  const actionButtonBaseClassName = "flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md disabled:cursor-not-allowed";
  const sendButtonClassName = `${actionButtonBaseClassName} bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const interruptButtonClassName = `${actionButtonBaseClassName} bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-300 disabled:text-gray-600 dark:bg-red-500 dark:text-white dark:hover:bg-red-400 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500`;
  const modelSelectId = `${composerInstanceId}-chat-model`;
  const messageInputId = `${composerInstanceId}-chat-message`;
  const secondaryActionsDisabled = isSubmitting || needsSshCredentials;
  const attachmentLimitReached = attachments.length >= MESSAGE_ATTACHMENT_LIMIT;
  const hasPendingComposerActions = attachments.length > 0
    || selectedTemplate.length > 0
    || (!isEmbedded && selectedModel.length > 0);

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
    if (
      (isActive ? hasQueueableInput : hasPendingInput)
      && (!isActive || selectedModel.length === 0 || selectedModelEnabled)
    ) {
      composerFormRef.current?.requestSubmit();
      return;
    }
    setShowDictationPopover(true);
  }

  function handleRemoveAttachment(attachmentId: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    setAttachmentError(null);
  }

  return {
    models,
    modelsLoading,
    currentModelKey,
    selectedModel,
    selectedModelEnabled,
    setSelectedModel,
    message,
    setMessage,
    selectedTemplate,
    setSelectedTemplate,
    attachments,
    setAttachments,
    attachmentError,
    setAttachmentError,
    isSubmitting,
    showDictationPopover,
    setShowDictationPopover,
    attachmentControlRef,
    composerFormRef,
    composerTextareaRef,
    dictationPopoverRef,
    isKeyboardVisible,
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
    modelSelectId,
    messageInputId,
    hasQueueableInput,
    hasPendingInput,
    secondaryActionsDisabled,
    attachmentLimitReached,
    hasPendingComposerActions,
    sendButtonClassName,
    interruptButtonClassName,
    handleSubmit,
    handleInterrupt,
    handlePaste,
    handleComposerKeyDown,
    handleDictationTranscript,
    handleDictationError: (error: string) => toast.error(error),
    handleSendPointerDown,
    handleSendPointerEnd,
    handleSendClick,
    handleRemoveAttachment,
  };
}
