import type { LogEntry } from "../../components/LogViewer";
import { detectTrailingPromiseMarker } from "../../utils/promise-markers";

function isResponseLogEntry(logEntry: LogEntry): boolean {
  return logEntry.details?.["logKind"] === "response";
}

function getResponseContent(logEntry: LogEntry): string | null {
  const responseContent = logEntry.details?.["responseContent"];
  return typeof responseContent === "string" ? responseContent : null;
}

export function normalizeFinalizedResponseLog(logEntry: LogEntry, finalizedContent?: string): LogEntry {
  if (!isResponseLogEntry(logEntry)) {
    return logEntry;
  }

  const responseContent = finalizedContent ?? getResponseContent(logEntry);
  if (!responseContent) {
    return logEntry.finalizedResponse ? { ...logEntry, finalizedResponse: undefined } : logEntry;
  }

  const markerMatch = detectTrailingPromiseMarker(responseContent);
  if (!markerMatch) {
    return logEntry.finalizedResponse ? { ...logEntry, finalizedResponse: undefined } : logEntry;
  }

  return {
    ...logEntry,
    finalizedResponse: {
      content: markerMatch.content,
      indicator: {
        marker: markerMatch.marker,
        kind: markerMatch.kind,
        label: markerMatch.label,
      },
    },
  };
}

export function normalizeHydratedLoopLogs(logs: LogEntry[]): LogEntry[] {
  return logs.map((logEntry) => normalizeFinalizedResponseLog(logEntry));
}

export function finalizeLatestResponseLog(logs: LogEntry[], finalizedContent: string): LogEntry[] {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const logEntry = logs[index];
    if (!logEntry || !isResponseLogEntry(logEntry)) {
      continue;
    }

    const normalized = normalizeFinalizedResponseLog(logEntry, finalizedContent);
    if (normalized === logEntry) {
      return logs;
    }

    const nextLogs = [...logs];
    nextLogs[index] = normalized;
    return nextLogs;
  }

  return logs;
}
