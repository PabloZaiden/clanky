import type { LogLevel } from "../../types";
import type { EntryBase, DisplayEntry } from "./types";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Format a timestamp for display.
 */
export function formatTime(isoString: string): string {
  return timeFormatter.format(new Date(isoString));
}

/**
 * Get the color for a log level.
 */
export function getLogLevelColor(level: LogLevel): string {
  switch (level) {
    case "agent":
      return "text-purple-400";
    case "debug":
      return "text-gray-500";
    case "info":
      return "text-cyan-400";
    case "warn":
      return "text-yellow-400";
    case "error":
      return "text-red-400";
    default:
      return "text-gray-400";
  }
}

/**
 * Derive a grouping key for an entry. Two consecutive entries belong to
 * the same visual group (and thus collapse their headers) when their
 * keys are equal.
 *
 * - Messages group by role: "message|user" (assistant messages are filtered out before grouping)
 * - Tool calls group by tool name: "tool|Write", "tool|Read"
 * - Log entries group by level + message: "log|agent|AI generating response..."
 */
export function getEntryGroupKey(entry: EntryBase): string {
  switch (entry.type) {
    case "message":
      return `message|${entry.data.role}`;
    case "tool":
      return `tool|${entry.data.name}`;
    case "log":
      return `log|${entry.data.level}|${entry.data.message}`;
  }
}

/**
 * Annotate a sorted array of entries with derived render metadata.
 * Timestamps are shown only when the visible formatted time changes.
 * Group headers remain driven by entry grouping so spacing and labels
 * still reflect structural changes within the transcript.
 */
export function annotateDisplayEntries(sorted: EntryBase[]): DisplayEntry[] {
  const keys = sorted.map(getEntryGroupKey);
  const visibleTimes = sorted.map((entry) => formatTime(entry.timestamp));

  return sorted.map((entry, i) => ({
    ...entry,
    showTimestamp: i === 0 || visibleTimes[i] !== visibleTimes[i - 1],
    showGroupHeader: i === 0 || keys[i] !== keys[i - 1],
  }));
}
