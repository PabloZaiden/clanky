import { useEffect, useRef } from "react";
import { getModelDisplayName, ModelSelector } from "../ModelSelector";
import {
  ImageAttachmentControl,
  ImageAttachmentPreviewList,
} from "../ImageAttachmentControl";
import {
  ComposerActionsMenu,
  ComposerActionsMenuButton,
  ComposerActionsMenuSection,
} from "../ComposerActionsMenu";
import { ConversationTemplateSelector } from "../conversation-template-selector";
import {
  Button,
  ComposerInterruptButton,
  MicrophoneIcon,
  PaperclipIcon,
} from "../common";
import { VoiceListeningPanel } from "./voice-listening-panel";
import { ComposerSendButton } from "./composer-send-button";
import { useConversationComposer } from "./use-conversation-composer";
import type { ConversationComposerProps } from "./types";
import { TokenUsage } from "../token-usage";

function ThinkingSpinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
      aria-hidden="true"
    />
  );
}

export function ConversationComposer(props: ConversationComposerProps) {
  const {
    active,
    attachmentsEnabled = true,
    disabled = false,
    modelEnabled = true,
    modelWorkspaceId,
    notice,
    status,
    questionAnswerInputFocused = false,
    voice,
  } = props;
  const state = useConversationComposer(props);
  const {
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
    isComposerBusy,
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
    hasContent,
    hasAttachmentWithoutMessage,
    controlsDisabled,
    attachmentLimitReached,
    handleSubmit,
    handleInterrupt,
    handlePaste,
    handleComposerKeyDown,
    handleRemoveAttachment,
  } = state;
  const showVoicePanel = Boolean(voice && voice.status !== "idle");
  const hideForQuestionAnswer = questionAnswerInputFocused && isKeyboardVisible;
  const voicePanelWasVisibleRef = useRef(false);

  useEffect(() => {
    if (voicePanelWasVisibleRef.current && !showVoicePanel) {
      composerTextareaRef.current?.focus();
    }
    voicePanelWasVisibleRef.current = showVoicePanel;
  }, [composerTextareaRef, showVoicePanel]);

  return (
    <div
      hidden={hideForQuestionAnswer}
      aria-hidden={hideForQuestionAnswer || undefined}
      className={`${isKeyboardVisible ? "" : "safe-area-bottom"} clanky-conversation-composer-surface`}
    >
      {showVoicePanel && voice ? (
        <VoiceListeningPanel
          status={voice.status}
          elapsedMs={voice.elapsedMs}
          error={voice.error}
          canRetryTranscription={voice.canRetryTranscription}
          onStop={voice.stop}
          onCancel={voice.cancel}
          onRetry={voice.retry}
          onDismissError={voice.dismissError}
        />
      ) : (
        <form
          ref={composerFormRef}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div className="p-3">
            {modelEnabled && (
              <label htmlFor={modelSelectId} className="sr-only">Model</label>
            )}
            <label htmlFor={messageInputId} className="sr-only">Message</label>
            {attachmentsEnabled && (
              <ImageAttachmentControl
                ref={attachmentControlRef}
                attachments={attachments}
                onChange={setAttachments}
                disabled={controlsDisabled}
                iconOnly
                showTrigger={false}
                showPreviewList={false}
                showErrorText={false}
                onErrorChange={setAttachmentError}
              />
            )}
            <div className="space-y-2">
              {notice && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                  <span>{notice.message}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void notice.onAction()}
                  >
                    {notice.actionLabel}
                  </Button>
                </div>
              )}
              {status && (
                <div
                  className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
                  aria-live="polite"
                >
                  <ThinkingSpinner />
                  <span>{status.label}</span>
                </div>
              )}
              {attachments.length > 0 && (
                <div className="min-w-0">
                  <ImageAttachmentPreviewList
                    attachments={attachments}
                    onRemoveAttachment={handleRemoveAttachment}
                    disabled={isComposerBusy}
                  />
                </div>
              )}
              <div className="flex min-w-0 items-end gap-2 sm:gap-3">
                <ComposerActionsMenu
                  ariaLabel="Message actions"
                  disabled={controlsDisabled}
                >
                  {props.tokenUsage !== undefined && (
                    <ComposerActionsMenuSection label="Usage">
                      <TokenUsage usage={props.tokenUsage} />
                    </ComposerActionsMenuSection>
                  )}
                  {modelEnabled && (
                    <ComposerActionsMenuSection label="Model">
                      <ModelSelector
                        id={modelSelectId}
                        value={selectedModel}
                        onChange={setSelectedModel}
                        models={models}
                        loading={modelsLoading}
                        disabled={controlsDisabled || active}
                        showDisconnected
                        currentModelKey={currentModelKey}
                        variantDiscovery={modelWorkspaceId
                          ? { workspaceId: modelWorkspaceId }
                          : undefined}
                        placeholder={currentModelKey
                          ? getModelDisplayName(models, currentModelKey)
                          : "Select model..."}
                        loadingText="Loading..."
                        emptyText="No models available"
                        className="clanky-composer-field clanky-composer-select block w-full rounded-md px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </ComposerActionsMenuSection>
                  )}
                  <ComposerActionsMenuSection label="Template">
                    <ConversationTemplateSelector
                      selectedTemplate={selectedTemplate}
                      onChange={setSelectedTemplate}
                      onPromptChange={setMessage}
                      disabled={controlsDisabled}
                      actions={(attachmentsEnabled || voice?.available) && (
                        <div className="flex shrink-0 items-center gap-3" role="group" aria-label="Message tools">
                          {voice?.available && (
                            <ComposerActionsMenuButton
                              label="Talk"
                              disabled={
                                controlsDisabled
                                || active
                                || voice.status !== "idle"
                                || hasContent
                              }
                              onClick={() => void voice.start()}
                            >
                              <span aria-hidden="true">
                                <MicrophoneIcon />
                              </span>
                            </ComposerActionsMenuButton>
                          )}
                          {attachmentsEnabled && (
                            <ComposerActionsMenuButton
                              label={attachmentLimitReached ? "Attachment limit reached" : "Attach file"}
                              disabled={controlsDisabled || attachmentLimitReached}
                              onClick={() => attachmentControlRef.current?.openFilePicker()}
                            >
                              <PaperclipIcon />
                            </ComposerActionsMenuButton>
                          )}
                        </div>
                      )}
                    />
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
                  disabled={controlsDisabled}
                  rows={composerRows}
                  className={`clanky-composer-field ${composerMinHeightClass} ${composerPaddingClass} min-w-0 w-full flex-1 resize-y rounded-md px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60`}
                />
                {active && !hasContent && props.onInterrupt ? (
                  <ComposerInterruptButton
                    onClick={() => void handleInterrupt()}
                    disabled={isComposerBusy || disabled}
                    busy={isComposerBusy}
                    ariaLabel="Interrupt"
                  />
                ) : (
                  <ComposerSendButton
                    disabled={
                      controlsDisabled
                      || hasAttachmentWithoutMessage
                      || (!active && selectedModel.length > 0 && !selectedModelEnabled)
                    }
                    label={active ? "Queue message" : "Send"}
                    onStartVoice={voice?.available && !active && voice.status === "idle" && !hasContent
                      ? voice.start : undefined}
                  >
                    {isComposerBusy ? (
                      <ThinkingSpinner />
                    ) : (
                      <span className="text-lg leading-none" aria-hidden="true">↑</span>
                    )}
                  </ComposerSendButton>
                )}
              </div>
            </div>
            {(attachmentError || submissionError) && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                {attachmentError ?? submissionError}
              </p>
            )}
            {modelEnabled && selectedModel && !selectedModelEnabled && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                The selected model's provider is not connected. Please select a different model.
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
