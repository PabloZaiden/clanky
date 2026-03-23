/**
 * LogViewer component for displaying real-time loop logs and messages.
 *
 * Performance: This component is memoized to prevent expensive re-renders
 * when typing in input fields. Without memoization, every keystroke would
 * re-render thousands of log entries, causing severe input lag.
 */

import { useEffect, useRef, useMemo, memo } from "react";
import type { EntryBase, LogViewerProps } from "./types";
import { annotateShowHeader } from "./utils";
import { MessageEntry } from "./message-entry";
import { ToolEntry } from "./tool-entry";
import { LogEntryItem } from "./log-entry-item";

/**
 * LogViewer displays messages, tool calls, and logs in chronological order.
 * Memoized to prevent re-renders when parent state changes (e.g., typing in inputs).
 */
export const LogViewer = memo(function LogViewer({
  messages,
  toolCalls,
  logs = [],
  autoScroll = true,
  maxHeight,
  showSystemInfo = false,
  showReasoning = true,
  showTools = false,
  markdownEnabled = false,
  isActive = false,
  id,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when content changes
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    }
  }, [messages, toolCalls, logs, autoScroll, showSystemInfo, showReasoning, showTools, markdownEnabled, isActive]);

  // Combine, sort, and annotate entries with showHeader for chat-style grouping
  const entries = useMemo(() => {
    const result: EntryBase[] = [];

    // User messages are always shown; assistant messages are filtered out because
    // their content is already displayed via AGENT response log entries (logKind: "response")
    messages.forEach((msg) => {
      if (msg.role === "user") {
        result.push({ type: "message", data: msg, timestamp: msg.timestamp });
      }
    });

    // Tool call entries: only shown if showTools is enabled
    if (showTools) {
      toolCalls.forEach((tool) => {
        result.push({ type: "tool", data: tool, timestamp: tool.timestamp });
      });
    }

    logs.forEach((logEntry) => {
      const logKind = logEntry.details?.["logKind"] as string | undefined;

      // Reasoning entries: only shown if showReasoning is enabled and have content
      if (logKind === "reasoning" || (!logKind && logEntry.message === "AI reasoning...")) {
        if (!showReasoning) return;
        const content = logEntry.details?.["responseContent"];
        if (typeof content === "string" && content.length > 0) {
          result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        }
        return;
      }

      // Legacy "AI calling tool:" entries are suppressed entirely (no longer emitted by backend).
      if (logKind === "tool" || (!logKind && logEntry.message.startsWith("AI calling tool:"))) {
        return;
      }

      // Response streaming entries ("AI generating response..."): shown only if they have content
      if (logKind === "response" || (!logKind && logEntry.message === "AI generating response...")) {
        const content = logEntry.details?.["responseContent"];
        if (typeof content === "string" && content.length > 0) {
          result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        }
        return;
      }

      // System agent messages (e.g., "AI started/finished generating response"): shown if showSystemInfo
      if (logKind === "system") {
        if (!showSystemInfo) return;
        result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        return;
      }

      // Non-agent levels (info, warn, error, debug, trace): shown if showSystemInfo
      if (logEntry.level !== "agent" && logEntry.level !== "user") {
        if (!showSystemInfo) return;
        result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
        return;
      }

      // Remaining agent/user entries without logKind (backward compatibility):
      // Use heuristics for old entries that don't have logKind
      if (logEntry.level === "agent" && !logKind) {
        // Old system-like messages
        if (logEntry.message.startsWith("AI started") || logEntry.message.startsWith("AI finished")) {
          if (!showSystemInfo) return;
        }
      }

      // Default: show the entry (user-level entries, and any unclassified agent entries)
      result.push({ type: "log", data: logEntry, timestamp: logEntry.timestamp });
    });

    // Sort by timestamp
    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Annotate with showHeader for chat-style consecutive grouping
    return annotateShowHeader(result);
  }, [messages, toolCalls, logs, showSystemInfo, showReasoning, showTools]);

  const isEmpty = entries.length === 0;

  return (
    <div
      ref={containerRef}
      id={id}
      className={`min-w-0 rounded-lg bg-neutral-900 text-xs text-gray-100 dark-scrollbar overflow-x-hidden overflow-y-auto font-mono sm:text-sm ${!maxHeight ? "flex-1 min-h-0" : ""}`}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {isEmpty ? (
        <div className="flex items-center justify-center h-32 text-gray-500 text-xs sm:text-sm">
          {isActive ? (
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
              <span>Working...</span>
            </div>
          ) : (
            "No logs yet. Waiting for activity."
          )}
        </div>
      ) : (
        <div className="p-2 sm:p-4">
          {entries.map((entry, index) => {
            // Chat-style spacing: tighter within a group, normal between groups
            const spacingClass = index === 0
              ? ""
              : entry.showHeader
                ? "mt-1 sm:mt-2"  // Normal spacing at group boundary
                : "mt-0.5";       // Tight spacing within a group
            if (entry.type === "message") {
              return (
                <MessageEntry
                  key={`msg-${entry.data.id}-${index}`}
                  data={entry.data}
                  showHeader={entry.showHeader}
                  spacingClass={spacingClass}
                  index={index}
                />
              );
            } else if (entry.type === "tool") {
              return (
                <ToolEntry
                  key={`tool-${entry.data.id}-${index}`}
                  data={entry.data}
                  timestamp={entry.timestamp}
                  showHeader={entry.showHeader}
                  spacingClass={spacingClass}
                  index={index}
                />
              );
            } else {
              return (
                <LogEntryItem
                  key={`log-${entry.data.id}-${index}`}
                  data={entry.data}
                  showHeader={entry.showHeader}
                  spacingClass={spacingClass}
                  index={index}
                  markdownEnabled={markdownEnabled}
                />
              );
            }
          })}
          {isActive && (
            <div className="flex items-center gap-2 text-gray-500 text-xs py-2" data-testid="working-indicator">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-500 border-t-transparent" />
              <span>Working...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
