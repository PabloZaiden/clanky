/**
 * LoopActionBar component for stop/send controls and model changes.
 *
 * This component provides a mobile-responsive action bar that allows users to:
 * - Stop an active generation
 * - Prepare and send the next message once generation is idle
 * - Change the model for the next turn or iteration
 *
 * The action bar is only visible when a loop is in an active state (running, waiting, planning).
 */

import { useState, useRef, useCallback, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ModelInfo, ModelConfig, LoopConfig } from "../types";
import type { ComposerImageAttachment, MessageImageAttachment } from "../types/message-attachments";
import { ModelSelector, makeModelKey, parseModelKey, isModelEnabled, getModelDisplayName } from "./ModelSelector";
import { createLogger } from "../lib/logger";
import {
  ImageAttachmentControl,
  ImageAttachmentPreviewList,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import { toMessageImageAttachments } from "../lib/image-attachments";
import { FocusPreservingButton, useComposerSizing } from "./common";

const log = createLogger("LoopActionBar");

export interface LoopActionBarProps {
  /** Mode of the loop */
  mode?: LoopConfig["mode"];
  /** Whether the loop is in planning mode */
  isPlanning?: boolean;
  /** Whether the loop is actively generating right now */
  isGenerating?: boolean;
  /** Current model configuration (from loop config) */
  currentModel?: ModelConfig;
  /** Available models for selection */
  models: ModelInfo[];
  /** Whether models are loading */
  modelsLoading: boolean;
  /** Callback when user submits a message and/or model change */
  onSubmit: (options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }) => Promise<boolean>;
  /** Callback when user stops the active agent without sending a message */
  onStop?: () => Promise<boolean>;
  /** Whether the action bar is disabled */
  disabled?: boolean;
  /** Require a message before submitting */
  requireMessage?: boolean;
  /** Override the submit button label */
  submitLabel?: string;

}

export function LoopActionBar({
  mode: _mode,
  isPlanning = false,
  isGenerating = false,
  currentModel,
  models,
  modelsLoading,
  onSubmit,
  onStop,
  disabled = false,
  requireMessage = false,
  submitLabel,
}: LoopActionBarProps) {
  const [message, setMessage] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);

  // Build current model key for display
  const currentModelKey = currentModel 
    ? makeModelKey(currentModel.providerID, currentModel.modelID, currentModel.variant)
    : "";

  const trimmedMessage = message.trim();

  // Check if user has local changes (not yet submitted)
  const hasLocalChanges = trimmedMessage.length > 0 || selectedModel !== "" || attachments.length > 0;
  const hasAttachmentWithoutMessage = attachments.length > 0 && trimmedMessage.length === 0;
  const canSubmit = hasLocalChanges && !hasAttachmentWithoutMessage && (!requireMessage || trimmedMessage.length > 0);
  const showStopButton = isGenerating && onStop !== undefined;

  // Check if the selected model is enabled (connected)
  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : true;
  const {
    composerRef,
    composerRows,
    composerMinHeightClass,
    composerPaddingClass,
  } = useComposerSizing(message);

  const resetComposerState = useCallback(() => {
    setMessage("");
    setSelectedModel("");
    setAttachments([]);
    setAttachmentError(null);
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    
    if (showStopButton || !canSubmit || disabled || isSubmitting) return;
    
    // Validate model is enabled if selected
    if (selectedModel && !selectedModelEnabled) return;

    log.debug("Submitting action bar changes", {
      hasMessage: !!message.trim(),
      hasModelChange: !!selectedModel,
    });
    setIsSubmitting(true);

    try {
      // Build the pending update
      const options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] } = {};
      
      if (message.trim()) {
        options.message = message.trim();
      }

      if (attachments.length > 0) {
        options.attachments = toMessageImageAttachments(attachments);
      }
      
      if (selectedModel) {
        const parsed = parseModelKey(selectedModel);
        if (parsed) {
          options.model = { providerID: parsed.providerID, modelID: parsed.modelID, variant: parsed.variant };
        }
      }

      const success = await onSubmit(options);
      if (success) {
        log.debug("Action bar changes submitted successfully");
        resetComposerState();
      } else {
        log.warn("Failed to submit action bar changes");
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [attachments, canSubmit, disabled, isSubmitting, message, onSubmit, resetComposerState, selectedModel, selectedModelEnabled, showStopButton]);

  const handleStop = useCallback(async () => {
    if (!onStop || disabled || isSubmitting) return;

    log.debug("Stopping active agent from composer");
    setIsSubmitting(true);
    try {
      await onStop();
    } finally {
      setIsSubmitting(false);
    }
  }, [disabled, isSubmitting, onStop]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    attachmentControlRef.current?.handlePaste(event);
  }, []);

  const handleComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composerFormRef.current?.requestSubmit();
    }
  }, []);

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-neutral-800 flex-shrink-0 safe-area-bottom">
      {/* Action bar form */}
      <form ref={composerFormRef} onSubmit={handleSubmit} className="p-3 sm:p-4">
        <div className="space-y-2" data-testid="loop-composer-layout">
          <div className="flex min-w-0 items-end gap-2 sm:gap-3" data-testid="loop-composer-main-row">
          {/* Model selector - hidden during planning since model changes are not supported */}
          {!isPlanning && (
            <div className="shrink-0" data-testid="loop-composer-model-cell">
              <ModelSelector
                value={selectedModel}
                onChange={setSelectedModel}
                models={models}
                loading={modelsLoading}
                disabled={disabled || isSubmitting}
                showDisconnected={true}
                currentModelKey={currentModelKey}
                placeholder={currentModelKey ? getModelDisplayName(models, currentModelKey) : "Select model..."}
                loadingText="Loading..."
                emptyText="Select model..."
                compactMobile
                className="h-9 w-9 min-w-0 sm:min-w-[128px] sm:w-40 md:w-48 rounded-md border border-gray-300 bg-white text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
              />
            </div>
          )}

            {/* Message input */}
            <textarea
              ref={composerRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              disabled={disabled || isSubmitting}
              rows={composerRows}
              aria-label={isPlanning ? "Plan feedback" : "Loop message"}
              className={`${composerMinHeightClass} ${composerPaddingClass} flex-1 min-w-0 w-full resize-y text-sm px-3 rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-neutral-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
            />
            <div className="shrink-0" data-testid="loop-composer-attachment-cell">
              <ImageAttachmentControl
                ref={attachmentControlRef}
                attachments={attachments}
                onChange={setAttachments}
                disabled={disabled || isSubmitting}
                iconOnly
                showPreviewList={false}
                showErrorText={false}
                onErrorChange={setAttachmentError}
              />
            </div>

            {/* Primary action button */}
            {showStopButton ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={disabled || isSubmitting}
                className="flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md bg-red-600 text-white hover:bg-red-500 disabled:bg-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed dark:bg-red-500 dark:text-white dark:hover:bg-red-400 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500"
                aria-label="Stop"
                title="Stop"
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
                disabled={disabled || isSubmitting || !canSubmit || (selectedModel !== "" && !selectedModelEnabled)}
                className="flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500"
                aria-label={submitLabel ?? (isPlanning ? "Send Feedback" : "Send")}
                title={submitLabel ?? (isPlanning ? "Send Feedback" : "Send")}
              >
                {isSubmitting ? (
                  <span className="animate-spin text-sm">⏳</span>
                ) : (
                  <span className="text-lg leading-none">↑</span>
                )}
              </FocusPreservingButton>
            )}
          </div>
          {attachments.length > 0 && (
            <div className="min-w-0" data-testid="loop-composer-attachments-row">
              <ImageAttachmentPreviewList
                attachments={attachments}
                onRemoveAttachment={(attachmentId) => {
                  setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
                  setAttachmentError(null);
                }}
                disabled={disabled || isSubmitting}
              />
            </div>
          )}
        </div>

        {/* Error message for disconnected model */}
        {attachmentError && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            {attachmentError}
          </p>
        )}
        {selectedModel && !selectedModelEnabled && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            The selected model's provider is not connected. Please select a different model.
          </p>
        )}
        {hasAttachmentWithoutMessage && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
            Add a message before sending images.
          </p>
        )}
      </form>
    </div>
  );
}
