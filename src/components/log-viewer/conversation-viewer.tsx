import { useMemo, memo } from "react";
import { ImageViewerModal } from "../ImageViewerModal";
import type { ConversationViewerProps, EntryBase } from "./types";
import {
  annotateReasoningBoundaries,
  annotateDisplayEntries,
  getEntrySpacingClass,
  groupConsecutiveEntries,
  hasActiveWorkEntry,
  isReasoningLogEntry,
  isResponseLogEntry,
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
  showSystemInfo = false,
  showTools = true,
  markdownEnabled = false,
  isActive = false,
  id,
  showAssistantMessages = false,
  showResponseLogs = true,
  showMessageRoles = false,
  emptyStateMessage = "No activity yet.",
  activeStateMessage = "Working...",
  onReadAloud,
  readAloudSummaryEnabled = false,
  playingReadAloudKey = null,
  readAloudStatus = null,
  toolPathDisplayRoot,
  fileLinkContext,
  surfaceClassName,
  transcriptClassName,
  onLoadToolDetails,
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
    logs.forEach((logEntry) => {
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
      if (msg.role === "assistant" && !showAssistantMessages) {
        result.push({
          type: "response-boundary",
          id: `assistant-response-${msg.id}`,
          timestamp: msg.timestamp,
          hasResponseContent: true,
        });
        return;
      }
      result.push({ type: "message", data: msg, timestamp: msg.timestamp });
    });

    if (showTools) {
      toolCalls.forEach((tool) => {
        result.push({ type: "tool", data: tool, timestamp: tool.timestamp });
      });
    }

    logs.forEach((logEntry) => {
      const logKind = logEntry.details?.["logKind"] as string | undefined;

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

      if (logKind === "tool" || (!logKind && logEntry.message.startsWith("AI calling tool:"))) {
        return;
      }

      if (isResponseLogEntry(logEntry)) {
        const content = logEntry.details?.["responseContent"];
        if (typeof content !== "string" || content.length === 0) {
          return;
        }
        if (!showResponseLogs) {
          result.push({
            type: "response-boundary",
            id: `response-log-${logEntry.id}`,
            timestamp: logEntry.timestamp,
            hasResponseContent: true,
          });
          return;
        }
        result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        return;
      }

      if (logKind === "system") {
        if (!showSystemInfo) return;
        result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        return;
      }

      if (logEntry.level !== "agent" && logEntry.level !== "user") {
        if (!showSystemInfo) return;
        result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        return;
      }

      if (logEntry.level === "agent" && !logKind) {
        if (logEntry.message.startsWith("AI started") || logEntry.message.startsWith("AI finished")) {
          if (!showSystemInfo) return;
        }
      }

      result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
    });

    result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return groupConsecutiveEntries(result, isActive);
  }, [isActive, logs, messages, showAssistantMessages, showResponseLogs, showSystemInfo, showTools, toolCalls]);

  const visibleEntries = useMemo(() => annotateDisplayEntries(groupedEntries), [groupedEntries]);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null,
    [messages],
  );
  const isEmpty = groupedEntries.length === 0;
  const hasActiveWorkRow = hasActiveWorkEntry(visibleEntries);
  const shouldShowWorkingIndicator = isActive && !isEmpty && !hasActiveWorkRow;
  const { containerRef, contentRef } = useStickyBottomScroll([
    visibleEntries,
    isActive,
    isEmpty,
    shouldShowWorkingIndicator,
    activeStateMessage,
    emptyStateMessage,
    markdownEnabled,
  ]);

  const resolvedSurfaceClassName = surfaceClassName ?? "bg-transparent";
  const resolvedTranscriptClassName = transcriptClassName ?? "mx-auto flex w-full max-w-7xl flex-col px-3 py-5 sm:px-4 sm:py-6 lg:px-6 xl:px-7";

  return (
    <>
      <div
        ref={containerRef}
        id={id}
        className={`dark-scrollbar min-w-0 overflow-x-hidden overflow-y-auto text-xs text-gray-700 dark:text-gray-100 sm:text-sm ${resolvedSurfaceClassName} ${!maxHeight ? "flex-1 min-h-0" : ""}`}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {isEmpty ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-xs sm:text-sm">
            {isActive ? (
              <div className="inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 dark:text-white/28">
                <ActivitySpinner className="h-3.5 w-3.5" />
                <span>{activeStateMessage}</span>
              </div>
            ) : (
              emptyStateMessage
            )}
          </div>
        ) : (
          <div ref={contentRef} className={resolvedTranscriptClassName} data-testid="conversation-transcript">
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
                    showRoleLabel={showMessageRoles}
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
                <span>{activeStateMessage}</span>
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
