import { useCallback, useMemo, memo } from "react";
import { shouldIncludeConversationTranscriptLog } from "@/shared";
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
import { ToolGroupEntry } from "./tool-group-entry";
import { ReasoningGroupEntry } from "./reasoning-group-entry";
import { WorkingGroupEntry } from "./working-group-entry";
import { LogEntryItem } from "./log-entry-item";
import { useStickyBottomScroll } from "./use-sticky-bottom-scroll";
import { useTranscriptImagePreview } from "./use-transcript-image-preview";
import { ActivitySpinner } from "./activity-spinner";

export const ConversationViewer = memo(function ConversationViewer({
  messages,
  toolCalls,
  logs = [],
  maxHeight,
  markdownEnabled = false,
  isActive = false,
  id,
  onReadAloud,
  readAloudSummaryEnabled = false,
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
      if (msg.role === "assistant" && msg.content.length === 0) {
        return;
      }
      result.push({ type: "message", data: msg, timestamp: msg.timestamp });
    });

    toolCalls.forEach((tool) => {
      result.push({ type: "tool", data: tool, timestamp: tool.timestamp });
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
    return groupConsecutiveEntries(result, isActive);
  }, [isActive, logs, messages, toolCalls]);

  const visibleEntries = useMemo(() => annotateDisplayEntries(groupedEntries), [groupedEntries]);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null,
    [messages],
  );
  const isEmpty = groupedEntries.length === 0;
  const hasActiveWorkRow = hasActiveWorkEntry(visibleEntries);
  const shouldShowWorkingIndicator = isActive && !isEmpty && !hasActiveWorkRow;
  const {
    containerRef,
    contentRef,
    preserveScrollPosition,
    cancelPreservedScrollPosition,
  } = useStickyBottomScroll([
    visibleEntries,
    isActive,
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
      <button
        type="button"
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
        disabled={loadingTranscript || !onLoadMoreTranscript}
        onClick={() => void handleLoadTranscript(onLoadMoreTranscript)}
      >
        {loadingTranscript ? "Loading…" : "Load more"}
      </button>
      <button
        type="button"
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"
        disabled={loadingTranscript || !onLoadFullTranscript}
        onClick={() => void handleLoadTranscript(onLoadFullTranscript)}
      >
        Load all
      </button>
    </div>
  );

  return (
    <>
      <div
        ref={containerRef}
        id={id}
        className={`dark-scrollbar min-w-0 overflow-x-hidden overflow-y-auto bg-transparent text-xs text-gray-700 dark:text-gray-100 sm:text-sm ${!maxHeight ? "flex-1 min-h-0" : ""}`}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {isEmpty ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-xs sm:text-sm">
            {isActive ? (
              <div className="inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 dark:text-white/28">
                <ActivitySpinner className="h-3.5 w-3.5" />
                <span>Thinking…</span>
              </div>
            ) : (
              "No messages yet"
            )}
          </div>
        ) : (
          <div ref={contentRef} className="mx-auto flex w-full max-w-7xl flex-col px-3 py-5 sm:px-4 sm:py-6 lg:px-6 xl:px-7" data-testid="conversation-transcript">
            {transcriptHistoryActions}
            {visibleEntries.map((entry, index) => {
              const spacingClass = getEntrySpacingClass(entry, visibleEntries[index - 1]);
              if (entry.type === "message") {
                return (
                  <MessageEntry
                    key={`msg-${entry.data.id}`}
                    data={entry.data}
                    showTimestamp={entry.showTimestamp}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                    onReadAloud={onReadAloud}
                    readAloudSummaryEnabled={readAloudSummaryEnabled}
                    playingReadAloudKey={playingReadAloudKey}
                    readAloudStatus={readAloudStatus}
                    readAloudDisabled={isActive && entry.data.id === latestAssistantMessageId}
                  />
                );
              } else if (entry.type === "tool") {
                return (
                  <ToolEntry
                    key={`tool-${entry.data.id}`}
                    data={entry.data}
                    timestamp={entry.timestamp}
                    showTimestamp={entry.showTimestamp}
                    spacingClass={spacingClass}
                    isActive={isActive && index === visibleEntries.length - 1 && isToolCallInProgress(entry.data)}
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
                    showGroupHeader={entry.showGroupHeader}
                    spacingClass={spacingClass}
                    markdownEnabled={markdownEnabled}
                    fileLinkContext={resolvedFileLinkContext}
                  />
                );
              }
            })}
            {shouldShowWorkingIndicator && (
              <div className="mt-4 inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 dark:text-white/28" data-testid="working-indicator">
                <ActivitySpinner />
                <span>Thinking…</span>
              </div>
            )}
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
