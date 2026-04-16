import { useEffect, useRef, useMemo, memo } from "react";
import type { ConversationViewerProps, EntryBase } from "./types";
import { annotateDisplayEntries, getEntryRenderKey, getStreamingEntryText, getStreamingTransitionState } from "./utils";
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
}: ConversationViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasSeenInitialEntriesRef = useRef(false);
  const previousStreamingTextRef = useRef<Map<string, string>>(new Map());

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

      if (logKind === "reasoning" || (!logKind && logEntry.message === "AI reasoning...")) {
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

      if (logKind === "response" || (!logKind && logEntry.message === "AI generating response...")) {
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
  const displayEntries = useMemo(() => {
    const canAnimateStreamingEntries = hasSeenInitialEntriesRef.current;
    return entries.map((entry) => ({
      ...entry,
      streamingTransition: getStreamingTransitionState(
        entry,
        previousStreamingTextRef.current,
        canAnimateStreamingEntries,
      ),
    }));
  }, [entries]);

  useEffect(() => {
    const nextStreamingText = new Map<string, string>();

    entries.forEach((entry) => {
      const streamingText = getStreamingEntryText(entry);
      if (typeof streamingText === "string") {
        nextStreamingText.set(getEntryRenderKey(entry), streamingText);
      }
    });

    previousStreamingTextRef.current = nextStreamingText;
    if (entries.length > 0) {
      hasSeenInitialEntriesRef.current = true;
    }
  }, [entries]);

  return (
    <div
      ref={containerRef}
      id={id}
      className={`min-w-0 rounded-lg bg-neutral-900 text-xs text-gray-100 dark-scrollbar overflow-x-hidden overflow-y-auto sm:text-sm ${!maxHeight ? "flex-1 min-h-0" : ""}`}
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
          <div className="p-2 sm:p-4">
          {displayEntries.map((entry, index) => {
            const spacingClass = index === 0
              ? ""
              : entry.showTimestamp || entry.showGroupHeader
                ? "mt-1 sm:mt-2"
                : "mt-0.5";
            if (entry.type === "message") {
              return (
                <MessageEntry
                  key={`msg-${entry.data.id}`}
                  data={entry.data}
                  showTimestamp={entry.showTimestamp}
                  spacingClass={spacingClass}
                  index={index}
                  markdownEnabled={markdownEnabled}
                  showRoleLabel={showMessageRoles}
                  streamingTransition={entry.streamingTransition}
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
                  index={index}
                  markdownEnabled={markdownEnabled}
                  streamingTransition={entry.streamingTransition}
                />
              );
            }
          })}
          {isActive && (
            <div className="flex items-center gap-2 text-gray-500 text-xs py-2" data-testid="working-indicator">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-500 border-t-transparent" />
              <span>{activeStateMessage}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
