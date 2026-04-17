import type { LogLevel } from "../../types";
import type {
  EntryBase,
  DisplayEntry,
  LogEntry,
  StreamingTextSegments,
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
 * Get the stable render key for an entry so update detection can survive
 * insertions elsewhere in the transcript without forcing remounts.
 */
export function getEntryRenderKey(entry: EntryBase): string {
  switch (entry.type) {
    case "message":
      return `message|${entry.data.id}`;
    case "tool":
      return `tool|${entry.data.id}`;
    case "log":
      return `log|${entry.data.id}`;
  }
}

export function isReasoningLogEntry(logEntry: LogEntry): boolean {
  const logKind = logEntry.details?.["logKind"] as string | undefined;
  return logKind === "reasoning" || (!logKind && logEntry.message === "AI reasoning...");
}

export function isResponseLogEntry(logEntry: LogEntry): boolean {
  const logKind = logEntry.details?.["logKind"] as string | undefined;
  return logKind === "response" || (!logKind && logEntry.message === "AI generating response...");
}

export function isStreamingLogEntry(logEntry: LogEntry): boolean {
  return isResponseLogEntry(logEntry) || isReasoningLogEntry(logEntry);
}

/**
 * Returns the streaming text payload for entries that should receive the
 * left-to-right suffix reveal treatment. Non-streaming entries return null.
 */
export function getStreamingEntryText(entry: EntryBase): string | null {
  if (entry.type === "message") {
    return entry.data.role === "assistant" ? entry.data.content : null;
  }

  if (entry.type !== "log") {
    return null;
  }

  if (!isStreamingLogEntry(entry.data)) {
    return null;
  }

  const responseContent = entry.data.details?.["responseContent"];
  return typeof responseContent === "string" && responseContent.length > 0
    ? responseContent
    : null;
}

export function getStreamingTextSegments(
  entry: EntryBase,
  previousStreamingText: Map<string, string>,
  canAnimate: boolean,
): StreamingTextSegments | null {
  const nextText = getStreamingEntryText(entry);
  if (nextText === null) {
    return null;
  }

  if (!canAnimate) {
    return {
      stablePrefix: nextText,
      animatedSuffix: "",
      transition: null,
      animationKey: null,
    };
  }

  const renderKey = getEntryRenderKey(entry);
  const previousText = previousStreamingText.get(renderKey);
  if (typeof previousText !== "string") {
    return {
      stablePrefix: "",
      animatedSuffix: nextText,
      transition: "enter",
      animationKey: `${renderKey}:enter:${nextText.length}`,
    };
  }

  if (nextText.length > previousText.length && nextText.startsWith(previousText)) {
    return {
      stablePrefix: previousText,
      animatedSuffix: nextText.slice(previousText.length),
      transition: "update",
      animationKey: `${renderKey}:update:${previousText.length}:${nextText.length}`,
    };
  }

  return {
    stablePrefix: nextText,
    animatedSuffix: "",
    transition: null,
    animationKey: null,
  };
}

/**
 * Annotate a sorted array of entries with derived render metadata.
 * Timestamps are shown only when the visible formatted time changes.
 * Group headers remain driven by entry grouping so spacing and labels
 * still reflect structural changes within the transcript.
 */
export function annotateDisplayEntries(sorted: EntryBase[]): DisplayEntry[] {
  const keys = sorted.map(getEntryGroupKey);
  const minuteBuckets = sorted.map((entry) =>
    getTimestampMinuteBucket(entry.timestamp),
  );

  return sorted.map((entry, i) => ({
    ...entry,
    showTimestamp: i === 0 || minuteBuckets[i] !== minuteBuckets[i - 1],
    showGroupHeader: i === 0 || keys[i] !== keys[i - 1],
    streamingText: null,
  }));
}
