import type { LogLevel } from "../../types";
import type { EntryBase, DisplayEntry } from "./types";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
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
 * Annotate a sorted array of entries with showHeader flags.
 * The first entry always shows its header. Subsequent entries only show
 * their header when their group key differs from the previous entry.
 *
 * Group keys are precomputed in a single pass to avoid redundant
 * string concatenations — each entry's key is computed exactly once.
 */
export function annotateShowHeader(sorted: EntryBase[]): DisplayEntry[] {
  // Precompute all group keys in one pass so each key is calculated exactly once
  const keys = sorted.map(getEntryGroupKey);
  return sorted.map((entry, i) => ({
    ...entry,
    showHeader: i === 0 || keys[i] !== keys[i - 1],
  }));
}
