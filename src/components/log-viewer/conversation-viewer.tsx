import { useMemo, useState, memo } from "react";
import type { ConversationViewerProps, EntryBase } from "./types";
import {
  annotateDisplayEntries,
  getEntrySpacingClass,
  groupConsecutiveToolEntries,
  isReasoningLogEntry,
  isResponseLogEntry,
} from "./utils";
import { MessageEntry } from "./message-entry";
import { ToolEntry } from "./tool-entry";
import { ToolGroupEntry } from "./tool-group-entry";
import { LogEntryItem } from "./log-entry-item";
import { useStickyBottomScroll } from "./use-sticky-bottom-scroll";

export const INITIAL_TRANSCRIPT_ENTRY_LIMIT = 100;
export const TRANSCRIPT_ENTRY_CHUNK_SIZE = 100;

export const ConversationViewer = memo(function ConversationViewer({
  messages,
  toolCalls,
  logs = [],
  maxHeight,
  showSystemInfo = false,
  showReasoning = true,
  showTools = true,
  markdownEnabled = false,
  isActive = false,
  id,
  showAssistantMessages = false,
  showResponseLogs = true,
  showMessageRoles = false,
  emptyStateMessage = "No activity yet.",
  activeStateMessage = "Working...",
  toolPathDisplayRoot,
  fileLinkContext,
  surfaceClassName,
  transcriptClassName,
}: ConversationViewerProps) {
  const [renderedEntryLimit, setRenderedEntryLimit] = useState(INITIAL_TRANSCRIPT_ENTRY_LIMIT);

  const groupedEntries = useMemo(() => {
    const result: EntryBase[] = [];

    messages.forEach((msg) => {
      if (msg.role === "assistant" && !showAssistantMessages) {
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
        if (!showReasoning) return;
        const content = logEntry.details?.["responseContent"];
        if (typeof content === "string" && content.length > 0) {
          result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        }
        return;
      }

      if (logKind === "tool" || (!logKind && logEntry.message.startsWith("AI calling tool:"))) {
        return;
      }

      if (isResponseLogEntry(logEntry)) {
        if (!showResponseLogs) return;
        const content = logEntry.details?.["responseContent"];
        if (typeof content === "string" && content.length > 0) {
          result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        }
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
    return groupConsecutiveToolEntries(result);
  }, [messages, toolCalls, logs, showSystemInfo, showReasoning, showTools, showAssistantMessages, showResponseLogs]);

  const visibleEntryCount = Math.min(renderedEntryLimit, groupedEntries.length);
  const hiddenEntryCount = Math.max(0, groupedEntries.length - visibleEntryCount);
  const visibleEntries = useMemo(
    () => annotateDisplayEntries(groupedEntries.slice(-visibleEntryCount)),
    [groupedEntries, visibleEntryCount],
  );
  const olderEntryLoadCount = Math.min(TRANSCRIPT_ENTRY_CHUNK_SIZE, hiddenEntryCount);
  const isEmpty = groupedEntries.length === 0;
  const { containerRef, contentRef } = useStickyBottomScroll([
    visibleEntries,
    isActive,
    isEmpty,
    activeStateMessage,
    emptyStateMessage,
    markdownEnabled,
  ]);

  const resolvedSurfaceClassName = surfaceClassName ?? "bg-gray-50 dark:bg-[#171717]";
  const resolvedTranscriptClassName = transcriptClassName ?? "mx-auto flex w-full max-w-7xl flex-col px-3 py-5 sm:px-4 sm:py-6 lg:px-6 xl:px-7";

  return (
    <div
      ref={containerRef}
      id={id}
      className={`dark-scrollbar min-w-0 overflow-x-hidden overflow-y-auto text-xs text-gray-700 dark:text-gray-100 sm:text-sm ${resolvedSurfaceClassName} ${!maxHeight ? "flex-1 min-h-0" : ""}`}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {isEmpty ? (
        <div className="flex items-center justify-center h-32 text-gray-500 text-xs sm:text-sm">
          {isActive ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
              <span>{activeStateMessage}</span>
            </div>
          ) : (
            emptyStateMessage
          )}
        </div>
      ) : (
        <div ref={contentRef} className={resolvedTranscriptClassName} data-testid="conversation-transcript">
          {hiddenEntryCount > 0 && (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                onClick={() => setRenderedEntryLimit((current) => current + TRANSCRIPT_ENTRY_CHUNK_SIZE)}
                className="rounded-full border border-gray-300 bg-white px-4 py-2 text-xs font-medium text-gray-700 shadow-sm hover:border-gray-400 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 dark:border-gray-700 dark:bg-neutral-800 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-neutral-700"
              >
                Show {olderEntryLoadCount} older {olderEntryLoadCount === 1 ? "entry" : "entries"}
              </button>
            </div>
          )}
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
                    fileLinkContext={fileLinkContext}
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
                  toolPathDisplayRoot={toolPathDisplayRoot}
                />
              );
            } else if (entry.type === "tool-group") {
              return (
                <ToolGroupEntry
                  key={`tool-group-${entry.id}`}
                  entry={entry}
                  spacingClass={spacingClass}
                  toolPathDisplayRoot={toolPathDisplayRoot}
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
                    fileLinkContext={fileLinkContext}
                  />
                );
            }
          })}
          {isActive && !isEmpty && (
            <div className="mt-4 flex items-center gap-2 py-1 text-xs text-gray-500" data-testid="working-indicator">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-500 border-t-transparent" />
              <span>{activeStateMessage}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
