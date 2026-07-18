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
import { ChatTemplateSelector } from "../chat-template-selector";
import { Button, FocusPreservingButton } from "../common";
import { DictationControls } from "../dictation";
import { useChatComposer } from "./chat-composer-state";
import type { ChatComposerProps } from "./types";

export function ChatComposer(props: ChatComposerProps) {
  const {
    chat,
    isEmbedded,
    isActive,
    needsSshCredentials,
    handleReconnect,
  } = props;
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
    isSubmitting,
    showDictationPopover,
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
    handleDictationError,
    handleSendPointerDown,
    handleSendPointerEnd,
    handleSendClick,
    handleRemoveAttachment,
  } = useChatComposer(props);

  return (
    <form
      ref={composerFormRef}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className={`${isKeyboardVisible ? "" : "safe-area-bottom"} border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-neutral-900`}
    >
      <div className="p-3" data-testid="chat-composer-padding">
        <label htmlFor={modelSelectId} className="sr-only">Model</label>
        <label htmlFor={messageInputId} className="sr-only">Message</label>
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
                    variantDiscovery={{ workspaceId: chat.config.workspaceId }}
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
                      onError={handleDictationError}
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
          {attachments.length > 0 && (
            <div className="min-w-0" data-testid="chat-composer-attachments-row">
              <ImageAttachmentPreviewList
                attachments={attachments}
                onRemoveAttachment={handleRemoveAttachment}
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
}
