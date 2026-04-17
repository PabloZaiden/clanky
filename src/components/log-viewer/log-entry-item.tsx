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

  return (
    <div className={`group ${isReasoning ? "opacity-60" : ""} ${spacingClass}`}>
      {showTimestamp && (
        <time className="text-gray-500 text-xs mb-0.5 block" dateTime={log.timestamp}>
          {formatTime(log.timestamp)}
        </time>
      )}
      <div className={`min-w-0 ${isReasoning ? "text-gray-400 italic" : getLogLevelColor(log.level)}`}>
        {showMessageLabel && (
          <span className="break-words">{log.message}</span>
        )}
        {/* Show responseContent as proper text */}
        {hasResponseContent && (
          <div className={`mt-2 rounded bg-neutral-800 p-2 sm:p-3 ${isReasoning ? "italic" : ""}`}>
            <StreamingTextContent
              content={responseContent as string}
              markdownEnabled={markdownEnabled}
              markdownClassName="text-xs"
              plainTextClassName={`text-xs leading-relaxed whitespace-pre-wrap break-words ${isReasoning ? "text-gray-400 italic" : "text-gray-200"}`}
              dimmed={isReasoning}
            />
          </div>
        )}
        {/* Show other details as JSON */}
        {hasOtherDetails && (
          <LazyDetails
            summary="Details"
            renderContent={renderDetails}
          />
        )}
      </div>
    </div>
  );
});
