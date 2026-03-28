/**
 * LoopActionBar component for sending messages and changing models mid-loop.
 * 
 * This component provides a mobile-responsive action bar that allows users to:
 * - Queue a message to be sent after the current iteration completes
 * - Change the model for subsequent iterations
 * 
 * The action bar is only visible when a loop is in an active state (running, waiting, planning).
 */

import { useState, useRef, useCallback, type ClipboardEvent, type FormEvent } from "react";
import type { ModelInfo, ModelConfig, LoopConfig } from "../types";
import type { ComposerImageAttachment, MessageImageAttachment } from "../types/message-attachments";
import { ModelSelector, makeModelKey, parseModelKey, isModelEnabled, getModelDisplayName } from "./ModelSelector";
import { createLogger } from "../lib/logger";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "./ImageAttachmentControl";
import { toMessageImageAttachments } from "../lib/image-attachments";

const log = createLogger("LoopActionBar");

export interface LoopActionBarProps {
  /** Mode of the loop: "loop" or "chat" */
  mode?: LoopConfig["mode"];
  /** Whether the loop is in planning mode */
  isPlanning?: boolean;
  /** Current model configuration (from loop config) */
  currentModel?: ModelConfig;
  /** Pending model that will be used for next iteration */
  pendingModel?: ModelConfig;
  /** Pending prompt that will be used for next iteration */
  pendingPrompt?: string;
  /** Available models for selection */
  models: ModelInfo[];
  /** Whether models are loading */
  modelsLoading: boolean;
  /** Callback when user queues a message and/or model change */
  onQueuePending: (options: { message?: string; model?: ModelConfig; attachments?: MessageImageAttachment[] }) => Promise<boolean>;
  /** Callback when user clears pending values */
  onClearPending: () => Promise<boolean>;
  /** Whether the action bar is disabled */
  disabled?: boolean;
  /** Require a message before submitting */
  requireMessage?: boolean;
  /** Override the submit button label */
  submitLabel?: string;

}

export function LoopActionBar({
  mode,
  isPlanning = false,
  currentModel,
  pendingModel,
  pendingPrompt,
  models,
  modelsLoading,
  onQueuePending,
  onClearPending,
  disabled = false,
  requireMessage = false,
  submitLabel,
}: LoopActionBarProps) {
  const [message, setMessage] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);

  const isChatMode = mode === "chat";

  // Build current model key for display
  const currentModelKey = currentModel 
    ? makeModelKey(currentModel.providerID, currentModel.modelID, currentModel.variant)
    : "";

  // Build pending model key for comparison
  const pendingModelKey = pendingModel
    ? makeModelKey(pendingModel.providerID, pendingModel.modelID, pendingModel.variant)
    : "";

  // Check if we have any pending changes
  const hasPendingMessage = !!pendingPrompt;
  const hasPendingModel = !!pendingModel;
  const hasPending = hasPendingMessage || hasPendingModel;

  // Check if user has local changes (not yet submitted)
  const hasLocalChanges = message.trim().length > 0 || selectedModel !== "";
  const hasAttachmentWithoutMessage = attachments.length > 0 && message.trim().length === 0;
  const canSubmit = hasLocalChanges && !hasAttachmentWithoutMessage && (!requireMessage || message.trim().length > 0);

  // Check if the selected model is enabled (connected)
  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : true;

  // Handle form submission
  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    
    if (!canSubmit || disabled || isSubmitting) return;
    
    // Validate model is enabled if selected
    if (selectedModel && !selectedModelEnabled) return;

    log.debug("Queueing pending changes", { 
      hasMessage: !!message.trim(), 
      hasModelChange: !!selectedModel 
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

      const success = await onQueuePending(options);
      if (success) {
        log.debug("Pending changes queued successfully");
        // Clear local state on success
        setMessage("");
        setSelectedModel("");
        setAttachments([]);
      } else {
        log.warn("Failed to queue pending changes");
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [attachments, canSubmit, disabled, isSubmitting, message, selectedModel, selectedModelEnabled, onQueuePending]);

  // Handle clear pending
  const handleClear = useCallback(async () => {
    if (disabled || isSubmitting || !hasPending) return;

    log.debug("Clearing pending changes");
    setIsSubmitting(true);
    try {
      await onClearPending();
      log.debug("Pending changes cleared");
    } finally {
      setIsSubmitting(false);
    }
  }, [disabled, isSubmitting, hasPending, onClearPending]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    attachmentControlRef.current?.handlePaste(event);
  }, []);

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-neutral-800 flex-shrink-0 safe-area-bottom">
      {/* Pending indicator */}
      {hasPending && (
        <div className="px-3 sm:px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800/50">
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              {hasPendingMessage && (
                <p className="text-xs text-yellow-800 dark:text-yellow-200 truncate">
                  <span className="font-medium">Queued message:</span> {pendingPrompt}
                </p>
              )}
              {hasPendingModel && (
                <p className="text-xs text-yellow-800 dark:text-yellow-200">
                  <span className="font-medium">Model change:</span> {getModelDisplayName(models, pendingModelKey)}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={disabled || isSubmitting}
              className="flex-shrink-0 text-xs text-yellow-700 dark:text-yellow-300 hover:text-yellow-900 dark:hover:text-yellow-100 disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Action bar form */}
      <form onSubmit={handleSubmit} className="p-3 sm:p-4">
        <div className="flex flex-row gap-2 sm:gap-3">
          {/* Model selector - hidden during planning since model changes are not supported */}
          {!isPlanning && (
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
              className="min-w-[112px] sm:min-w-[128px] md:w-48 max-w-[120px] sm:max-w-none flex-shrink-0 h-9 text-sm rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-neutral-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
          )}

          {/* Message input */}
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onPaste={handlePaste}
            placeholder={isPlanning ? "Send feedback on the plan..." : isChatMode ? "Type a message..." : "Send a message to steer the agent..."}
            disabled={disabled || isSubmitting}
            className="flex-1 min-w-0 h-9 text-sm px-3 rounded-md border border-gray-300 bg-white dark:border-gray-600 dark:bg-neutral-700 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />

          {/* Image attachment button (icon-only) */}
          <ImageAttachmentControl
            ref={attachmentControlRef}
            attachments={attachments}
            onChange={setAttachments}
            disabled={disabled || isSubmitting}
            iconOnly
          />

          {/* Submit button (compact arrow) */}
          <button
            type="submit"
            disabled={disabled || isSubmitting || !canSubmit || (selectedModel !== "" && !selectedModelEnabled)}
            className="flex-shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-md bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-gray-950 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-800 dark:disabled:text-gray-500"
            aria-label={submitLabel ?? (isPlanning ? "Send Feedback" : isChatMode ? "Send" : "Queue")}
            title={submitLabel ?? (isPlanning ? "Send Feedback" : isChatMode ? "Send" : "Queue")}
          >
            {isSubmitting ? (
              <span className="animate-spin text-sm">⏳</span>
            ) : (
              <span className="text-lg leading-none">↑</span>
            )}
          </button>
        </div>

        {/* Error message for disconnected model */}
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
