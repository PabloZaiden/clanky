import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
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
import { useAvailableModels } from "../../hooks";
import {
  MESSAGE_ATTACHMENT_LIMIT,
  toMessageAttachments,
} from "../../lib/image-attachments";
import { apiRequest } from "../../lib/api-client";
import {
  createChatComposerDraftPersistence,
  getStoredChatComposerDraft,
} from "../../lib/chat-composer-drafts";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@/shared";
import type { Chat, ComposerAttachment } from "@/shared";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { getChatErrorMessage } from "./chat-lifecycle";
import type { ChatComposerProps } from "./types";
import { useToast } from "@pablozaiden/webapp/web";
import { isAbortError } from "../../lib/request-lifecycle";
import { getStoredSshCredentialToken } from "../../lib/ssh-browser-credentials";

export function useChatComposer({
  chat,
  chatId,
  isEmbedded,
  isActive,
  isExternallyBusy = false,
  needsSshCredentials,
  onChatSnapshot,
  markChatStarting,
  refreshChat,
  onSendMessage,
}: ChatComposerProps) {
  const toast = useToast();
  const draftPersistence = useMemo(
    () => createChatComposerDraftPersistence(chatId),
    [chatId],
  );
  const [message, setMessageState] = useState(
    () => getStoredChatComposerDraft(chatId) ?? "",
  );
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visualViewport = useVisualViewport(true);
  const isKeyboardVisible = isVisualViewportReduced(
    visualViewport,
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  const { models, modelsLoading } = useAvailableModels({
    workspaceId: isEmbedded
      || chat.config.source?.kind === "execution_host"
      ? undefined
      : chat.config.workspaceId,
  });

  const setMessage = useCallback((nextMessage: string): void => {
    setMessageState(nextMessage);
    draftPersistence.schedule(nextMessage);
  }, [draftPersistence]);

  useLayoutEffect(() => {
    const restoredMessage = getStoredChatComposerDraft(chatId) ?? "";
    setMessageState(restoredMessage);
  }, [chatId]);

  useEffect(() => {
    function flushOnPageHide(): void {
      draftPersistence.flush();
    }

    function flushWhenHidden(): void {
      if (document.visibilityState === "hidden") {
        draftPersistence.flush();
      }
    }

    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      draftPersistence.flush();
      draftPersistence.cancel();
    };
  }, [draftPersistence]);

  useEffect(() => {
    setSelectedModel("");
  }, [chat.config.model.modelID, chat.config.model.providerID, chat.config.model.variant]);

  const currentModelKey = makeModelKey(
    chat.config.model.providerID,
    chat.config.model.modelID,
    chat.config.model.variant,
  );
  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : true;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting || isExternallyBusy) {
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

        const updatedChat = await apiRequest<Chat>(`/api/chats/${chatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
              variant: parsedModel.variant,
            },
          }),
          action: "Update chat model",
          fallbackMessage: "Failed to update chat model",
        });
        onChatSnapshot(updatedChat);
        setSelectedModel("");
      }

      if (trimmedMessage.length === 0 && attachments.length === 0) {
        return;
      }

      const messageAttachments = attachments.length > 0 ? toMessageAttachments(attachments) : [];
      if (onSendMessage) {
        const nextChat = await onSendMessage({
          message: trimmedMessage.length > 0 ? trimmedMessage : undefined,
          attachments: messageAttachments,
        });
        onChatSnapshot(nextChat);
      } else {
        const source = chat.config.source;
        const serverId = source?.kind === "execution_host"
          && source.executionHost.host.kind === "ssh"
          ? getRegisteredSshServerId(source.executionHost.host)
          : null;
        const credentialToken = serverId
          ? await getStoredSshCredentialToken(serverId)
          : null;
        const data = await apiRequest<{ chat?: Chat }>(`/api/chats/${chatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmedMessage.length > 0 ? trimmedMessage : null,
            attachments: messageAttachments,
            credentialToken,
          }),
          action: "Send chat message",
          fallbackMessage: "Failed to send chat message",
        });
        if (data.chat) {
          onChatSnapshot(data.chat);
        } else if (isActive) {
          await refreshChat();
        } else {
          markChatStarting();
        }
      }
      draftPersistence.clear();
      setMessageState("");
      setSelectedTemplate("");
      setAttachments([]);
      setAttachmentError(null);
    } catch (submitError) {
      if (!isAbortError(submitError)) {
        toast.error(String(submitError));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleInterrupt(): Promise<void> {
    if (!isActive || isSubmitting || isExternallyBusy) {
      return;
    }

    setIsSubmitting(true);
    try {
      const nextChat = await apiRequest<Chat>(`/api/chats/${chatId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: DEFAULT_CHAT_INTERRUPT_REASON }),
        action: "Interrupt chat",
        fallbackMessage: "Failed to interrupt chat",
      });
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
  const sendButtonClassName = "wapp-action-menu-trigger wapp-action-menu-trigger-compact flex-shrink-0";
  const modelSelectId = `${composerInstanceId}-chat-model`;
  const messageInputId = `${composerInstanceId}-chat-message`;
  const composerBusy = isSubmitting || isExternallyBusy;
  const secondaryActionsDisabled = composerBusy || needsSshCredentials;
  const attachmentLimitReached = attachments.length >= MESSAGE_ATTACHMENT_LIMIT;

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
    isComposerBusy: composerBusy,
    attachmentControlRef,
    composerFormRef,
    composerTextareaRef,
    isKeyboardVisible,
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
    modelSelectId,
    messageInputId,
    hasQueueableInput,
    secondaryActionsDisabled,
    attachmentLimitReached,
    sendButtonClassName,
    handleSubmit,
    handleInterrupt,
    handlePaste,
    handleComposerKeyDown,
    handleRemoveAttachment,
  };
}
