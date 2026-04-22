import { memo, useCallback } from "react";
import { LazyDetails } from "./lazy-details";
import { StreamingTextContent } from "./streaming-text-content";
import type { LogEntry } from "./types";
import { formatTime, getLogLevelColor, isReasoningLogEntry } from "./utils";

interface LogEntryItemProps {
  data: LogEntry;
  showTimestamp: boolean;
  showGroupHeader: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
}

function getOtherDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== "responseContent" && key !== "logKind")
  );
}

export const LogEntryItem = memo(function LogEntryItem({
  data: log,
  showTimestamp,
  showGroupHeader,
  spacingClass,
  markdownEnabled,
}: LogEntryItemProps) {
  const details = log.details;
  const logKind = log.details?.["logKind"] as string | undefined;
  const isReasoning = isReasoningLogEntry(log);
  const isResponse = logKind === "response";
  const responseContent = log.details?.["responseContent"];
  const hasResponseContent = typeof responseContent === "string" && responseContent.length > 0;
  const hasOtherDetails = details
    ? Object.keys(details).some((key) => key !== "responseContent" && key !== "logKind")
    : false;
  const renderDetails = useCallback(
    () => (
      <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto">
        {JSON.stringify(getOtherDetails(details!), null, 2)}
      </pre>
    ),
    [details]
  );

  // Don't render response/reasoning entries with no displayable content
  const isResponseOrReasoning = logKind === "response" || logKind === "reasoning";
  if (isResponseOrReasoning && !hasResponseContent && !hasOtherDetails) {
    return null;
  }

  // Streaming text entries (response, reasoning) don't need a message label —
  // their rendered content is already self-explanatory.
  const hidesTypedStreamingLabel = logKind === "response" || logKind === "reasoning";
  const showMessageLabel = showGroupHeader && !hidesTypedStreamingLabel;
  const textColorClassName = isReasoning
    ? "text-gray-400"
    : isResponse || log.level === "agent"
      ? "text-white"
      : getLogLevelColor(log.level);

  return (
    <div className={`group ${spacingClass}`} data-log-kind={logKind ?? "default"}>
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={log.timestamp}>
          {formatTime(log.timestamp)}
        </time>
      )}
      <div className={`min-w-0 max-w-[min(92%,48rem)] ${textColorClassName}`}>
        {showMessageLabel && (
          <span className="break-words text-sm leading-7">{log.message}</span>
        )}
        {hasResponseContent && (
          <div className={showMessageLabel ? "mt-2" : ""}>
            <StreamingTextContent
              content={responseContent as string}
              markdownEnabled={markdownEnabled}
              markdownClassName={`text-sm leading-7 ${isReasoning ? "text-gray-400" : "text-white"}`}
              plainTextClassName={`text-sm leading-7 whitespace-pre-wrap break-words ${isReasoning ? "text-gray-400" : "text-white"}`}
              dimmed={isReasoning}
            />
          </div>
        )}
        {hasOtherDetails && (
          <LazyDetails
            summary="Details"
            renderContent={renderDetails}
            className="mt-2"
            triggerClassName="text-left text-xs text-gray-500 transition hover:text-gray-300"
            panelClassName="mt-2"
          />
        )}
      </div>
    </div>
  );
});
