import { useCallback, useMemo, memo } from "react";
import { Button, useToast } from "@pablozaiden/webapp/web";
import type { VoiceTranslationResponse } from "@/contracts/schemas";
import type { VoiceTranslationLanguage } from "@/shared";
import { hasToolCallImagePreview } from "@/shared/tool-call";
import { useForegroundPresentation } from "../../hooks/useForegroundPresentation";
import { apiRequest } from "../../lib/api-client";
import {
  isCountedAssistantResponse,
  shouldIncludeConversationTranscriptLog,
} from "@/shared";
import { ImageViewerModal } from "../ImageViewerModal";
import type { ConversationViewerProps, EntryBase } from "./types";
import {
  annotateReasoningBoundaries,
  annotateDisplayEntries,
  getEntrySpacingClass,
  groupConsecutiveEntries,
  hasActiveWorkEntry,
  isReasoningLogEntry,
  isToolCallInProgress,
} from "./utils";
import { MessageEntry } from "./message-entry";
import { ToolEntry } from "./tool-entry";
import { ToolImageEntry } from "./tool-image-entry";
import { ToolGroupEntry } from "./tool-group-entry";
import { ReasoningGroupEntry } from "./reasoning-group-entry";
import { WorkingGroupEntry } from "./working-group-entry";
import { LogEntryItem } from "./log-entry-item";
import { useStickyBottomScroll } from "./use-sticky-bottom-scroll";
import { useTranscriptImagePreview } from "./use-transcript-image-preview";
import { ActivityIndicator } from "./activity-indicator";

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

export const ConversationViewer = memo(function ConversationViewer(props: ConversationViewerProps) {
  const presentation = useForegroundPresentation(props);
  return <ConversationPresentation {...presentation} />;
});

const ConversationPresentation = memo(function ConversationPresentation({
  messages,
  toolCalls,
  logs = [],
  maxHeight,
  markdownEnabled = false,
  isActive = false,
  isWorking,
  scrollContentFooter,
  id,
  onReadAloud,
  playingReadAloudKey = null,
  readAloudStatus = null,
  toolPathDisplayRoot,
  fileLinkContext,
  onLoadToolDetails,
  hasOlderTranscript = false,
  onLoadMoreTranscript,
  onLoadFullTranscript,
  loadingTranscript = false,
}: ConversationViewerProps) {
  const { error: notifyError } = useToast();
  const translateMessage = useCallback(async (
    text: string,
    targetLanguage: VoiceTranslationLanguage,
    signal: AbortSignal,
  ): Promise<string> => {
    const language = targetLanguage === "en" ? "English" : "Spanish";
    const response = await apiRequest<VoiceTranslationResponse>("/api/voice/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLanguage }),
      signal,
      action: `Translate transcript to ${language}`,
      fallbackMessage: `Failed to translate transcript to ${language}`,
    });
    const translatedText = response.translatedText.trim();
    if (!translatedText) {
      throw new Error("The text provider returned an empty translation.");
    }
    return translatedText;
  }, []);
  const handleTranslationError = useCallback((error: unknown): void => {
    if (!isAbortError(error)) {
      notifyError(String(error));
    }
  }, [notifyError]);

  const imagePreview = useTranscriptImagePreview(fileLinkContext);
  const resolvedFileLinkContext = useMemo(() => {
    if (!fileLinkContext) {
      return undefined;
    }
    return {
      ...fileLinkContext,
      openImagePreview: imagePreview.openImagePreview,
    };
  }, [fileLinkContext, imagePreview.openImagePreview]);

  const hasActiveWork = isWorking ?? isActive;

  const groupedEntries = useMemo(() => {
    // Preserve all source events for reasoning boundaries; empty response
    // placeholders are filtered from the visible grouping below.
    const sourceEntries: EntryBase[] = [];
    messages.forEach((msg) => {
      sourceEntries.push({ type: "message", data: msg, timestamp: msg.timestamp });
    });

    toolCalls.forEach((tool) => {
      sourceEntries.push({ type: "tool", data: tool, timestamp: tool.timestamp });
    });
    logs.filter(shouldIncludeConversationTranscriptLog).forEach((logEntry) => {
      sourceEntries.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
    });
    sourceEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const annotatedSourceEntries = annotateReasoningBoundaries(sourceEntries);
    const reasoningEntriesById = new Map<string, Extract<EntryBase, { type: "log" }>>();
    annotatedSourceEntries.forEach((sourceEntry) => {
      if (sourceEntry.type === "log" && isReasoningLogEntry(sourceEntry.data)) {
        reasoningEntriesById.set(sourceEntry.data.id, sourceEntry);
      }
    });

    const result: EntryBase[] = [];

    messages.forEach((msg) => {
      if (msg.role === "assistant" && !isCountedAssistantResponse(msg)) {
        return;
      }
      result.push({ type: "message", data: msg, timestamp: msg.timestamp });
    });

    toolCalls.forEach((tool) => {
      result.push({
        type: hasToolCallImagePreview(tool) ? "tool-image" : "tool",
        data: tool,
        timestamp: tool.timestamp,
      });
    });

    logs.filter(shouldIncludeConversationTranscriptLog).forEach((logEntry) => {
      if (isReasoningLogEntry(logEntry)) {
        const content = logEntry.details?.["responseContent"];
        if (typeof content === "string" && content.length > 0) {
          const reasoningEntry = reasoningEntriesById.get(logEntry.id);
          result.push({
            type: "log",
            data: logEntry,
            timestamp: logEntry.timestamp,
            reasoningGroupId: reasoningEntry?.reasoningGroupId,
            reasoningEndTimestamp: reasoningEntry?.reasoningEndTimestamp,
          });
        }
        return;
      }

      result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
    });

    result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return groupConsecutiveEntries(result, hasActiveWork);
  }, [hasActiveWork, logs, messages, toolCalls]);

  const visibleEntries = useMemo(() => annotateDisplayEntries(groupedEntries), [groupedEntries]);
  const isEmpty = groupedEntries.length === 0;
  const hasActiveWorkRow = hasActiveWorkEntry(visibleEntries);
  const shouldShowWorkingIndicator = hasActiveWork && !isEmpty && !hasActiveWorkRow;
  const {
    containerRef,
    contentRef,
    preserveScrollPosition,
    cancelPreservedScrollPosition,
    releaseBottomPin,
  } = useStickyBottomScroll([
    visibleEntries,
    isActive,
    hasActiveWork,
    isEmpty,
    shouldShowWorkingIndicator,
    markdownEnabled,
  ]);

  const handleLoadTranscript = useCallback(
    async (load: (() => Promise<void>) | undefined): Promise<void> => {
      if (!load) {
        return;
      }
      preserveScrollPosition();
      try {
        await load();
      } finally {
        cancelPreservedScrollPosition();
      }
    },
    [cancelPreservedScrollPosition, preserveScrollPosition],
  );

  const transcriptHistoryActions = hasOlderTranscript && (
    <div
      className="mb-5 flex flex-wrap items-center justify-center gap-2 border-b border-gray-200/70 pb-4 dark:border-white/10"
      data-testid="transcript-history-actions"
    >
      <Button
        type="button"
        disabled={loadingTranscript || !onLoadMoreTranscript}
        onClick={() => void handleLoadTranscript(onLoadMoreTranscript)}
      >
        {loadingTranscript ? "Loading…" : "Load more"}
      </Button>
      <Button
        type="button"
        disabled={loadingTranscript || !onLoadFullTranscript}
        onClick={() => void handleLoadTranscript(onLoadFullTranscript)}
      >
        Load all
      </Button>
    </div>
  );

  return (
    <>
      <div
        ref={containerRef}
        id={id}
        className={`dark-scrollbar min-w-0 overflow-x-hidden overflow-y-auto bg-transparent text-lg text-gray-700 dark:text-gray-100 ${!maxHeight ? "flex-1 min-h-0" : ""}`}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {isEmpty ? (
          <div
            ref={contentRef}
            className="mx-auto flex min-h-full w-full max-w-7xl flex-col px-3 sm:px-4 lg:px-6 xl:px-7"
            data-testid="conversation-transcript"
          >
            <div className="flex h-32 shrink-0 items-center justify-center text-gray-500 text-xs sm:text-sm">
              {hasActiveWork ? (
                <ActivityIndicator className="rounded-md py-0.5 text-left text-base text-gray-400 dark:text-white/28">
                  <span>Thinking…</span>
                </ActivityIndicator>
              ) : (
                "No messages yet"
              )}
            </div>
            {scrollContentFooter}
          </div>
        ) : (
          <div ref={contentRef} className="mx-auto flex w-full max-w-7xl flex-col px-3 py-5 sm:px-4 sm:py-6 lg:px-6 xl:px-7" data-testid="conversation-transcript">
            {transcriptHistoryActions}
            {visibleEntries.map((entry, index) => {
              const spacingClass = getEntrySpacingClass(entry, visibleEntries[index - 1]);
              if (entry.type === "message") {
                const messageReadAloudKey = playingReadAloudKey === entry.data.id
                  ? entry.data.id
                  : null;
                return (
                  <MessageEntry
                    key={`msg-${entry.data.id}`}
                    data={entry.data}
                    showTimestamp={entry.showTimestamp}
                    showDate={entry.showDate}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                    onTranslate={translateMessage}
                    onTranslationError={handleTranslationError}
                    onReadAloud={onReadAloud}
                    playingReadAloudKey={messageReadAloudKey}
                    readAloudStatus={messageReadAloudKey ? readAloudStatus : null}
                    onBeforeExpand={releaseBottomPin}
                  />
                );
              } else if (entry.type === "tool-image") {
                return (
                  <ToolImageEntry
                    key={`tool-image-${entry.data.id}`}
                    data={entry.data}
                    timestamp={entry.timestamp}
                    showTimestamp={entry.showTimestamp}
                    showDate={entry.showDate}
                    spacingClass={spacingClass}
                    toolPathDisplayRoot={toolPathDisplayRoot}
                    onLoadToolDetails={onLoadToolDetails}
                  />
                );
              } else if (entry.type === "tool") {
                return (
                  <ToolEntry
                    key={`tool-${entry.data.id}`}
                    data={entry.data}
                    timestamp={entry.timestamp}
                    showTimestamp={entry.showTimestamp}
                    showDate={entry.showDate}
                    spacingClass={spacingClass}
                    isActive={hasActiveWork && index === visibleEntries.length - 1 && isToolCallInProgress(entry.data)}
                    toolPathDisplayRoot={toolPathDisplayRoot}
                    onLoadToolDetails={onLoadToolDetails}
                  />
                );
              } else if (entry.type === "tool-group") {
                return (
                  <ToolGroupEntry
                    key={`tool-group-${entry.id}`}
                    entry={entry}
                    spacingClass={spacingClass}
                    toolPathDisplayRoot={toolPathDisplayRoot}
                    onLoadToolDetails={onLoadToolDetails}
                  />
                );
              } else if (entry.type === "reasoning-group") {
                return (
                  <ReasoningGroupEntry
                    key={`reasoning-group-${entry.id}`}
                    entry={entry}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                  />
                );
              } else if (entry.type === "working-group") {
                return (
                  <WorkingGroupEntry
                    key={`working-group-${entry.id}`}
                    entry={entry}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                    toolPathDisplayRoot={toolPathDisplayRoot}
                    onLoadToolDetails={onLoadToolDetails}
                  />
                );
              } else {
                return (
                  <LogEntryItem
                    key={`log-${entry.data.id}`}
                    data={entry.data}
                    showTimestamp={entry.showTimestamp}
                    showDate={entry.showDate}
                    showGroupHeader={entry.showGroupHeader}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                  />
                );
              }
            })}
            {shouldShowWorkingIndicator && (
              <ActivityIndicator className="mt-4 rounded-md py-0.5 text-left text-base text-gray-400 dark:text-white/28" data-testid="working-indicator">
                <span>Thinking…</span>
              </ActivityIndicator>
            )}
            {scrollContentFooter}
          </div>
        )}
      </div>
      {fileLinkContext && (
        <ImageViewerModal
          image={imagePreview.image}
          loading={imagePreview.loading}
          title={imagePreview.title}
          onClose={imagePreview.closeImagePreview}
        />
      )}
    </>
  );
});
