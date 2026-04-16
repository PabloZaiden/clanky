import type { LogLevel } from "../../types";
import type { EntryBase, DisplayEntry, StreamingTransitionState } from "./types";

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

/**
 * Returns the streaming text payload for entries that should receive the
 * soft fade treatment. Non-streaming entries return null.
 */
export function getStreamingEntryText(entry: EntryBase): string | null {
  if (entry.type === "message") {
    return entry.data.role === "assistant" ? entry.data.content : null;
  }

  if (entry.type !== "log") {
    return null;
  }

  const logKind = entry.data.details?.["logKind"] as string | undefined;
  const isStreamingLog = logKind === "response" || logKind === "reasoning";
  if (!isStreamingLog) {
    return null;
  }

  const responseContent = entry.data.details?.["responseContent"];
  return typeof responseContent === "string" && responseContent.length > 0
    ? responseContent
    : null;
}

export function getStreamingTransitionState(
  entry: EntryBase,
  previousStreamingText: Map<string, string>,
  canAnimate: boolean,
): StreamingTransitionState {
  if (!canAnimate) {
    return null;
  }

  const nextText = getStreamingEntryText(entry);
  if (nextText === null) {
    return null;
  }

  const previousText = previousStreamingText.get(getEntryRenderKey(entry));
  if (typeof previousText !== "string") {
    return "enter";
  }

  if (nextText.length > previousText.length && nextText.startsWith(previousText)) {
    return "update";
  }

  return null;
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
    streamingTransition: null,
  }));
}
