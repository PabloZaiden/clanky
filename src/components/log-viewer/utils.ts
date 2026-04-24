import type { LogLevel } from "../../types";
import type {
  EntryBase,
  GroupedEntryBase,
  DisplayEntry,
  LogEntry,
  ToolGroupEntryBase,
} from "./types";

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
 * Group timestamps by their absolute minute so repeated local clock values
 * across different dates or DST fall-back hours do not collapse together.
 */
function getTimestampMinuteBucket(isoString: string): number {
  return Math.floor(new Date(isoString).getTime() / 60_000);
}

/**
 * Get the color for a log level.
 */
export function getLogLevelColor(level: LogLevel): string {
  switch (level) {
    case "agent":
      return "text-gray-900 dark:text-white";
    case "debug":
      return "text-gray-500 dark:text-gray-400";
    case "info":
      return "text-sky-700 dark:text-cyan-400";
    case "warn":
      return "text-amber-700 dark:text-yellow-400";
    case "error":
      return "text-red-700 dark:text-red-400";
    default:
      return "text-gray-600 dark:text-gray-400";
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
export function getEntryGroupKey(entry: GroupedEntryBase): string {
  switch (entry.type) {
    case "message":
      return `message|${entry.data.role}`;
    case "tool":
      return `tool|${entry.data.name}`;
    case "tool-group":
      return "tool-group";
    case "log":
      return `log|${entry.data.level}|${entry.data.message}`;
  }
}

function createToolGroupEntry(tools: ToolGroupEntryBase["tools"]): ToolGroupEntryBase {
  const firstTool = tools[0]!;
  const lastTool = tools[tools.length - 1]!;
  return {
    type: "tool-group",
    id: firstTool.id,
    tools,
    timestamp: firstTool.timestamp,
    lastTimestamp: lastTool.timestamp,
  };
}

export function groupConsecutiveToolEntries(sorted: EntryBase[]): GroupedEntryBase[] {
  const groupedEntries: GroupedEntryBase[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!;
    if (entry.type !== "tool") {
      groupedEntries.push(entry);
      continue;
    }

    const consecutiveTools = [entry.data];
    let cursor = index + 1;
    while (cursor < sorted.length && sorted[cursor]?.type === "tool") {
      consecutiveTools.push((sorted[cursor] as Extract<EntryBase, { type: "tool" }>).data);
      cursor += 1;
    }

    groupedEntries.push(createToolGroupEntry(consecutiveTools));
    index = cursor - 1;
  }

  return groupedEntries;
}

export function isReasoningLogEntry(logEntry: LogEntry): boolean {
  const logKind = logEntry.details?.["logKind"] as string | undefined;
  return logKind === "reasoning" || (!logKind && logEntry.message === "AI reasoning...");
}

export function isResponseLogEntry(logEntry: LogEntry): boolean {
  const logKind = logEntry.details?.["logKind"] as string | undefined;
  return logKind === "response" || (!logKind && logEntry.message === "AI generating response...");
}

/**
 * Annotate a sorted array of entries with derived render metadata.
 * Timestamps are shown only when the visible formatted time changes.
 * Group headers remain driven by entry grouping so spacing and labels
 * still reflect structural changes within the transcript.
 */
export function annotateDisplayEntries(sorted: GroupedEntryBase[]): DisplayEntry[] {
  const keys = sorted.map(getEntryGroupKey);
  const minuteBuckets = sorted.map((entry) =>
    getTimestampMinuteBucket(entry.timestamp),
  );

  return sorted.map((entry, i) => ({
    ...entry,
    showTimestamp: i === 0 || minuteBuckets[i] !== minuteBuckets[i - 1],
    showGroupHeader: i === 0 || keys[i] !== keys[i - 1],
  }));
}

export function getEntrySpacingClass(entry: DisplayEntry, previousEntry?: DisplayEntry): string {
  if (!previousEntry) {
    return "";
  }

  if (previousEntry.type === "tool" && entry.type === "tool") {
    return "mt-3 sm:mt-4";
  }

  return entry.showTimestamp || entry.showGroupHeader
    ? "mt-6 sm:mt-7"
    : "mt-3 sm:mt-4";
}
