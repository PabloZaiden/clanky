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
import type { ComposerAttachment, ModelConfig } from "@/shared";
import type { ImageAttachmentControlHandle } from "../ImageAttachmentControl";
import {
  isModelEnabled,
  makeModelKey,
  parseModelKey,
} from "../ModelSelector";
import {
  isVisualViewportReduced,
  useComposerSizing,
  useVisualViewport,
} from "../common";
import { useAvailableModels } from "../../hooks/useAvailableModels";
import {
  MESSAGE_ATTACHMENT_LIMIT,
  toMessageAttachments,
} from "../../lib/image-attachments";
import {
  createConversationComposerDraftPersistence,
  getStoredConversationComposerDraft,
} from "../../lib/conversation-composer-drafts";
import { isAbortError } from "../../lib/request-lifecycle";
import type { ConversationComposerProps } from "./types";

export function useConversationComposer({
  draftId,
  currentModel,
  modelWorkspaceId,
  modelEnabled = true,
  attachmentsEnabled = true,
  active,
  externallyBusy = false,
  disabled = false,
  requireMessage = false,
  voice,
  onSubmit,
  onInterrupt,
}: ConversationComposerProps) {
  const draftPersistence = useMemo(
    () => createConversationComposerDraftPersistence(draftId),
    [draftId],
  );
  const [message, setMessageState] = useState(
    () => getStoredConversationComposerDraft(draftId) ?? "",
  );
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageRef = useRef(message);
  const attachmentsRef = useRef(attachments);
  const visualViewport = useVisualViewport(true);
  const isKeyboardVisible = isVisualViewportReduced(
    visualViewport,
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  const { models, modelsLoading } = useAvailableModels({
    workspaceId: modelEnabled ? modelWorkspaceId : undefined,
  });

  const setMessage = useCallback((nextMessage: string): void => {
    setMessageState(nextMessage);
    setSubmissionError(null);
    draftPersistence.schedule(nextMessage);
  }, [draftPersistence]);

  messageRef.current = message;
  attachmentsRef.current = attachments;

  useLayoutEffect(() => {
    setMessageState(getStoredConversationComposerDraft(draftId) ?? "");
    setSelectedTemplate("");
    setSelectedModel("");
    setAttachments([]);
    setAttachmentError(null);
    setSubmissionError(null);
  }, [draftId]);

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
  }, [currentModel.modelID, currentModel.providerID, currentModel.variant]);

  const currentModelKey = makeModelKey(
    currentModel.providerID,
    currentModel.modelID,
    currentModel.variant,
  );
  const selectedModelEnabled = selectedModel
    ? isModelEnabled(models, selectedModel)
    : true;
  const hasModelChange = modelEnabled
    && selectedModel.length > 0
    && selectedModel !== currentModelKey;

  const submitMessage = useCallback(async (
    messageOverride?: string,
  ): Promise<void> => {
    if (isSubmitting || externallyBusy || disabled) {
      return;
    }

    const trimmedMessage = (messageOverride ?? messageRef.current).trim();
    const currentAttachments = attachmentsRef.current;
    const hasContent = trimmedMessage.length > 0 || currentAttachments.length > 0;
    if (active && !hasContent) {
      return;
    }
    if (!hasContent && !hasModelChange) {
      return;
    }
    if (requireMessage && trimmedMessage.length === 0) {
      setSubmissionError("Enter a message.");
      return;
    }
    if (hasModelChange && !selectedModelEnabled) {
      return;
    }

    let nextModel: ModelConfig | null = null;
    if (hasModelChange) {
      const parsedModel = parseModelKey(selectedModel);
      if (!parsedModel) {
        setSubmissionError("Failed to parse the selected model.");
        return;
      }
      nextModel = parsedModel;
    }

    setIsSubmitting(true);
    setSubmissionError(null);
    try {
      const succeeded = await onSubmit({
        message: trimmedMessage.length > 0 ? trimmedMessage : null,
        model: nextModel,
        attachments: attachmentsEnabled && currentAttachments.length > 0
          ? toMessageAttachments(currentAttachments)
          : [],
      });
      if (succeeded === false) {
        return;
      }
      draftPersistence.clear();
      setMessageState("");
      setSelectedTemplate("");
      setSelectedModel("");
      setAttachments([]);
      setAttachmentError(null);
    } catch (error) {
      if (!isAbortError(error)) {
        setSubmissionError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    active,
    attachmentsEnabled,
    disabled,
    draftPersistence,
    externallyBusy,
    hasModelChange,
    isSubmitting,
    onSubmit,
    requireMessage,
    selectedModel,
    selectedModelEnabled,
  ]);

  useEffect(() => {
    if (!voice) {
      return;
    }
    return voice.registerDraft(
      (transcript: string) => {
        setMessage(transcript);
      },
      () => (
        messageRef.current.trim()
        || (attachmentsRef.current.length > 0 ? "attachment" : "")
      ),
      submitMessage,
    );
  }, [setMessage, submitMessage, voice]);

  useEffect(() => {
    return () => {
      voice?.cancel();
    };
  }, [voice?.cancel]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await submitMessage();
  }

  async function handleInterrupt(): Promise<void> {
    if (!active || !onInterrupt || isSubmitting || externallyBusy || disabled) {
      return;
    }

    setIsSubmitting(true);
    setSubmissionError(null);
    try {
      await onInterrupt();
    } catch (error) {
      if (!isAbortError(error)) {
        setSubmissionError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (attachmentsEnabled) {
      attachmentControlRef.current?.handlePaste(event);
    }
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
  const hasContent = message.trim().length > 0 || attachments.length > 0;
  const composerBusy = isSubmitting || externallyBusy;
  const controlsDisabled = composerBusy || disabled;

  function handleRemoveAttachment(attachmentId: string): void {
    setAttachments((current) => (
      current.filter((attachment) => attachment.id !== attachmentId)
    ));
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
    submissionError,
    isComposerBusy: composerBusy,
    attachmentControlRef,
    composerFormRef,
    composerTextareaRef,
    isKeyboardVisible,
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
    modelSelectId: `${composerInstanceId}-model`,
    messageInputId: `${composerInstanceId}-message`,
    hasContent,
    controlsDisabled,
    attachmentLimitReached: attachments.length >= MESSAGE_ATTACHMENT_LIMIT,
    handleSubmit,
    handleInterrupt,
    handlePaste,
    handleComposerKeyDown,
    handleRemoveAttachment,
  };
}
