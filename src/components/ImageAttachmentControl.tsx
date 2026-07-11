import {
  useMemo,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type ForwardedRef,
} from "react";
import type { ComposerImageAttachment } from "../types/message-attachments";
import {
  MESSAGE_IMAGE_ACCEPT,
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  createComposerImageAttachments,
  getClipboardImageFiles,
  revokeComposerImageAttachments,
} from "../lib/image-attachments";
import { readClipboardContent } from "../utils";
import { ClipboardPasteIcon } from "./common";
import { ImageViewerModal } from "./ImageViewerModal";

interface ImageAttachmentControlProps {
  attachments: ComposerImageAttachment[];
  onChange: (attachments: ComposerImageAttachment[]) => void;
  disabled?: boolean;
  compact?: boolean;
  hint?: string;
  /** When true, render only a small icon button with no text or hint */
  iconOnly?: boolean;
  /** When false, suppress the attachment preview list. */
  showPreviewList?: boolean;
  /** When false, suppress the inline error text. */
  showErrorText?: boolean;
  /** Optional callback fired whenever the current error text changes. */
  onErrorChange?: (error: string | null) => void;
  /** When false, keep the input/ref mounted without rendering a visible picker button. */
  showTrigger?: boolean;
  /** When true, render a clipboard paste button beside the image picker. */
  showClipboardTrigger?: boolean;
  /** Receives text from the clipboard when no image is present. */
  onClipboardText?: (text: string) => void;
}

export interface ImageAttachmentControlHandle {
  handlePaste: (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  openFilePicker: () => void;
}

interface ImageAttachmentPreviewListProps {
  attachments: ComposerImageAttachment[];
  onRemoveAttachment: (attachmentId: string) => void;
  disabled?: boolean;
}

export function ImageAttachmentPreviewList({
  attachments,
  onRemoveAttachment,
  disabled = false,
}: ImageAttachmentPreviewListProps) {
  const [selectedAttachment, setSelectedAttachment] = useState<ComposerImageAttachment | null>(null);

  useEffect(() => {
    if (selectedAttachment && !attachments.some((attachment) => attachment.id === selectedAttachment.id)) {
      setSelectedAttachment(null);
    }
  }, [attachments, selectedAttachment]);

  const selectedImage = useMemo(() => selectedAttachment ? {
    src: selectedAttachment.previewUrl,
    alt: selectedAttachment.filename,
    title: selectedAttachment.filename,
    description: `${Math.max(1, Math.round(selectedAttachment.size / 1024))} KB`,
  } : null, [selectedAttachment]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="group relative flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-2 dark:border-gray-700 dark:bg-neutral-800"
          >
            <button
              type="button"
              onClick={() => setSelectedAttachment(attachment)}
              className="flex min-w-0 items-center gap-2 rounded text-left focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
              aria-label={`View ${attachment.filename}`}
            >
              <img
                src={attachment.previewUrl}
                alt={attachment.filename}
                className="h-10 w-10 rounded object-cover"
              />
              <div className="min-w-0">
                <p className="max-w-32 truncate text-xs text-gray-700 dark:text-gray-200">
                  {attachment.filename}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  {Math.max(1, Math.round(attachment.size / 1024))} KB
                </p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => onRemoveAttachment(attachment.id)}
              disabled={disabled}
              className="rounded p-1 text-xs text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 disabled:opacity-50"
              aria-label={`Remove ${attachment.filename}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <ImageViewerModal
        image={selectedImage}
        onClose={() => setSelectedAttachment(null)}
      />
    </>
  );
}

function ImageAttachmentControlInner({
  attachments,
  onChange,
  disabled = false,
  compact = false,
  hint,
  iconOnly = false,
  showPreviewList = true,
  showErrorText = true,
  onErrorChange,
  showTrigger = true,
  showClipboardTrigger = false,
  onClipboardText,
}: ImageAttachmentControlProps, ref: ForwardedRef<ImageAttachmentControlHandle>) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const clipboardReadInProgressRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);

  useEffect(() => {
    const previous = attachmentsRef.current;
    attachmentsRef.current = attachments;

    // Revoke object URLs for attachments that were removed or replaced.
    const currentIds = new Set(attachments.map((a) => a.id));
    for (const prev of previous) {
      if (!currentIds.has(prev.id)) {
        URL.revokeObjectURL(prev.previewUrl);
      }
    }
  }, [attachments]);

  useEffect(() => {
    return () => {
      revokeComposerImageAttachments(attachmentsRef.current);
    };
  }, []);

  useEffect(() => {
    onErrorChange?.(error ? error.replace(/^Error:\s*/, "") : null);
  }, [error, onErrorChange]);

  const addFiles = useCallback(async (files: File[]) => {
    if (disabled || files.length === 0) {
      return;
    }
    setError(null);

    try {
      const nextAttachments = await createComposerImageAttachments(
        files,
        attachmentsRef.current.length,
      );
      onChange([...attachmentsRef.current, ...nextAttachments]);
    } catch (attachmentError) {
      setError(String(attachmentError));
    } finally {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }, [disabled, onChange]);

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    await addFiles(Array.from(fileList));
  }

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const files = getClipboardImageFiles(event.clipboardData?.items);
      if (files.length === 0 || disabled) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void addFiles(files);
    },
    [addFiles, disabled],
  );

  const handleClipboardPaste = useCallback(async () => {
    if (
      disabled
      || attachmentsRef.current.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT
      || clipboardReadInProgressRef.current
    ) {
      return;
    }

    clipboardReadInProgressRef.current = true;
    setIsReadingClipboard(true);
    setError(null);

    try {
      const clipboardContent = await readClipboardContent();
      if (clipboardContent.imageFiles.length > 0) {
        await addFiles(clipboardContent.imageFiles);
      } else if (clipboardContent.text !== null && clipboardContent.text.length > 0) {
        onClipboardText?.(clipboardContent.text);
      }
    } catch (clipboardError) {
      setError(String(clipboardError));
    } finally {
      clipboardReadInProgressRef.current = false;
      setIsReadingClipboard(false);
    }
  }, [addFiles, disabled, onClipboardText]);

  const openFilePicker = useCallback(() => {
    if (disabled || attachmentsRef.current.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT) {
      return;
    }
    inputRef.current?.click();
  }, [disabled]);

  useImperativeHandle(ref, () => ({ handlePaste, openFilePicker }), [handlePaste, openFilePicker]);

  function handleRemoveAttachment(attachmentId: string) {
    const nextAttachments = attachments.filter((attachment) => attachment.id !== attachmentId);
    const removedAttachment = attachments.find((attachment) => attachment.id === attachmentId);
    if (removedAttachment) {
      URL.revokeObjectURL(removedAttachment.previewUrl);
    }
    onChange(nextAttachments);
    setError(null);
  }

  const buttonLabel = attachments.length > 0
    ? `Add image (${attachments.length}/${MESSAGE_IMAGE_ATTACHMENT_LIMIT})`
    : "Add image";
  const clipboardButtonLabel = isReadingClipboard
    ? "Pasting from clipboard..."
    : "Paste from clipboard";
  const errorText = error ? error.replace(/^Error:\s*/, "") : null;

  return (
    <div className={iconOnly && attachments.length === 0 && !error ? "" : "space-y-2"}>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={MESSAGE_IMAGE_ACCEPT}
          multiple
          className="hidden"
          disabled={disabled}
          onChange={(event) => void handleFilesSelected(event.target.files)}
        />
        {showTrigger && iconOnly ? (
          <button
            type="button"
            onClick={openFilePicker}
            disabled={disabled || attachments.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-neutral-700 text-gray-700 dark:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 disabled:cursor-not-allowed disabled:opacity-50 flex-shrink-0"
            aria-label={buttonLabel}
            title={buttonLabel}
          >
            <span aria-hidden="true" className="text-base">📎</span>
          </button>
        ) : showTrigger ? (
          <>
            <button
              type="button"
              onClick={openFilePicker}
              disabled={disabled || attachments.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT}
              className={`inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-neutral-700 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:border-gray-400 dark:hover:border-gray-500 disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "" : "text-sm"}`}
            >
              <span aria-hidden="true">📎</span>
              <span>{buttonLabel}</span>
            </button>
            {hint && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {hint}
              </span>
            )}
          </>
        ) : null}
        {showClipboardTrigger && (
          <button
            type="button"
            onClick={() => void handleClipboardPaste()}
            disabled={
              disabled
              || isReadingClipboard
              || attachments.length >= MESSAGE_IMAGE_ATTACHMENT_LIMIT
            }
            className={iconOnly
              ? "inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:hover:border-gray-500"
              : `inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:hover:border-gray-500 ${compact ? "" : "text-sm"}`}
            aria-label={clipboardButtonLabel}
            title={clipboardButtonLabel}
            aria-busy={isReadingClipboard}
          >
            <ClipboardPasteIcon />
            {!iconOnly && <span>{clipboardButtonLabel}</span>}
          </button>
        )}
      </div>

      {showErrorText && errorText && (
        <p className="text-xs text-red-600 dark:text-red-400">
          {errorText}
        </p>
      )}

      {showPreviewList && (
        <ImageAttachmentPreviewList
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          disabled={disabled}
        />
      )}
    </div>
  );
}

export const ImageAttachmentControl = forwardRef(ImageAttachmentControlInner);
ImageAttachmentControl.displayName = "ImageAttachmentControl";
