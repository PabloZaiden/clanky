import { useEffect, useRef, useMemo, memo } from "react";
import type { ConversationViewerProps, EntryBase } from "./types";
import {
  annotateDisplayEntries,
  isReasoningLogEntry,
  isResponseLogEntry,
} from "./utils";
import { MessageEntry } from "./message-entry";
import { ToolEntry } from "./tool-entry";
import { LogEntryItem } from "./log-entry-item";

export const ConversationViewer = memo(function ConversationViewer({
  messages,
  toolCalls,
  logs = [],
  autoScroll = true,
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
}: ConversationViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    }
  }, [
    messages,
    toolCalls,
    logs,
    autoScroll,
    showSystemInfo,
    showReasoning,
    showTools,
    markdownEnabled,
    isActive,
    showAssistantMessages,
    showResponseLogs,
  ]);

  const entries = useMemo(() => {
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

    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return annotateDisplayEntries(result);
  }, [messages, toolCalls, logs, showSystemInfo, showReasoning, showTools, showAssistantMessages, showResponseLogs]);

  const isEmpty = entries.length === 0;

  return (
    <div
      ref={containerRef}
      id={id}
      className={`dark-scrollbar min-w-0 overflow-x-hidden overflow-y-auto bg-[#171717] text-xs text-gray-100 sm:text-sm ${!maxHeight ? "flex-1 min-h-0" : ""}`}
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
          <div
            className="mx-auto flex w-full max-w-7xl flex-col px-3 py-5 sm:px-4 sm:py-6 lg:px-5"
            data-testid="conversation-transcript"
          >
          {entries.map((entry, index) => {
            const spacingClass = index === 0
              ? ""
              : entry.showTimestamp || entry.showGroupHeader
                ? "mt-6 sm:mt-7"
                : "mt-3 sm:mt-4";
            if (entry.type === "message") {
              return (
                <MessageEntry
                  key={`msg-${entry.data.id}`}
                  data={entry.data}
                  showTimestamp={entry.showTimestamp}
                  spacingClass={spacingClass}
                  markdownEnabled={markdownEnabled}
                  showRoleLabel={showMessageRoles}
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
            } else {
              return (
                <LogEntryItem
                  key={`log-${entry.data.id}`}
                  data={entry.data}
                  showTimestamp={entry.showTimestamp}
                  showGroupHeader={entry.showGroupHeader}
                  spacingClass={spacingClass}
                  markdownEnabled={markdownEnabled}
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
