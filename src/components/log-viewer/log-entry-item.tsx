import { memo, useCallback } from "react";
import { Badge } from "../common/Badge";
import type { BadgeVariant } from "../common/Badge";
import { LazyDetails } from "./lazy-details";
import { StreamingTextContent } from "./streaming-text-content";
import type { LogEntry, TranscriptFileLinkContext } from "./types";
import { formatTime, getLogLevelColor, isReasoningLogEntry } from "./utils";

interface LogEntryItemProps {
  data: LogEntry;
  showTimestamp: boolean;
  showGroupHeader: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  deferMarkdown?: boolean;
}

function getOtherDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== "responseContent" && key !== "logKind")
  );
}

function getFinalizedResponseBadgeVariant(log: LogEntry): BadgeVariant {
  switch (log.finalizedResponse?.indicator.kind) {
    case "complete":
      return "completed";
    case "plan_ready":
      return "plan_ready";
    case "blocked":
      return "warning";
    default:
      return "default";
  }
}

export const LogEntryItem = memo(function LogEntryItem({
  data: log,
  showTimestamp,
  showGroupHeader,
  spacingClass,
  markdownEnabled,
  fileLinkContext,
  deferMarkdown = false,
}: LogEntryItemProps) {
  const details = log.details;
  const logKind = log.details?.["logKind"] as string | undefined;
  const isReasoning = isReasoningLogEntry(log);
  const isResponse = logKind === "response";
  const responseContent = log.finalizedResponse?.content ?? log.details?.["responseContent"];
  const hasResponseContent = typeof responseContent === "string" && responseContent.length > 0;
  const finalizedResponseIndicator = log.finalizedResponse?.indicator;
  const hasOtherDetails = details
    ? Object.keys(details).some((key) => key !== "responseContent" && key !== "logKind")
    : false;
  const renderDetails = useCallback(
    () => (
      <pre className="mt-1 overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-900 dark:bg-neutral-800 dark:text-gray-100">
        {JSON.stringify(getOtherDetails(details!), null, 2)}
      </pre>
    ),
    [details]
  );

  // Don't render response/reasoning entries with no displayable content
  const isResponseOrReasoning = logKind === "response" || logKind === "reasoning";
  if (isResponseOrReasoning && !hasResponseContent && !hasOtherDetails && !finalizedResponseIndicator) {
    return null;
  }

  // Streaming text entries (response, reasoning) don't need a message label —
  // their rendered content is already self-explanatory.
  const hidesTypedStreamingLabel = logKind === "response" || logKind === "reasoning";
  const showMessageLabel = showGroupHeader && !hidesTypedStreamingLabel;
  const textColorClassName = isReasoning
    ? "text-gray-500 dark:text-gray-400"
    : isResponse || log.level === "agent"
      ? "text-gray-900 dark:text-white"
      : getLogLevelColor(log.level);
  const logTone = isReasoning
    ? "reasoning"
    : isResponse || log.level === "agent"
      ? "agent"
      : log.level;
  const widthClassName = isResponseOrReasoning
    ? "min-w-0 w-full"
    : "min-w-0 max-w-[min(96%,72rem)]";

  return (
    <div className={`group ${spacingClass}`} data-log-kind={logKind ?? "default"}>
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={log.timestamp}>
          {formatTime(log.timestamp)}
        </time>
      )}
      <div
        className={`${widthClassName} ${textColorClassName}`}
        data-log-tone={logTone}
      >
        {showMessageLabel && (
          <span className="break-words text-sm leading-7">{log.message}</span>
        )}
        {hasResponseContent && (
          <div className={showMessageLabel ? "mt-2" : ""}>
            <StreamingTextContent
              content={responseContent as string}
              markdownEnabled={markdownEnabled}
              dimmed={isReasoning}
              markdownClassName={`text-sm leading-7 ${isReasoning ? "text-gray-500 dark:text-gray-400" : "text-gray-900 dark:text-white"}`}
              plainTextClassName={`text-sm leading-7 whitespace-pre-wrap break-words ${isReasoning ? "text-gray-500 dark:text-gray-400" : "text-gray-900 dark:text-white"}`}
              fileLinkContext={fileLinkContext}
              deferMarkdown={deferMarkdown}
            />
          </div>
        )}
        {finalizedResponseIndicator && (
          <div
            className={hasResponseContent ? "mt-3" : showMessageLabel ? "mt-2" : ""}
            data-response-outcome={finalizedResponseIndicator.kind}
            data-promise-marker={finalizedResponseIndicator.marker}
          >
            <Badge variant={getFinalizedResponseBadgeVariant(log)} size="sm">
              {finalizedResponseIndicator.label}
            </Badge>
          </div>
        )}
        {hasOtherDetails && (
          <LazyDetails
            summary="Details"
            renderContent={renderDetails}
            className="mt-2"
            triggerClassName="text-left text-xs text-gray-500 transition hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            panelClassName="mt-2"
          />
        )}
      </div>
    </div>
  );
});
