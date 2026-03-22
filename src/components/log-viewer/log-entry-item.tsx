import { memo, useCallback } from "react";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { LazyDetails } from "./lazy-details";
import type { LogEntry } from "./types";
import { formatTime, getLogLevelColor } from "./utils";

interface LogEntryItemProps {
  data: LogEntry;
  showHeader: boolean;
  spacingClass: string;
  index: number;
  markdownEnabled: boolean;
}

function getOtherDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== "responseContent" && key !== "logKind")
  );
}

export const LogEntryItem = memo(function LogEntryItem({ data: log, showHeader, spacingClass, index, markdownEnabled }: LogEntryItemProps) {
  const details = log.details;
  const logKind = log.details?.["logKind"] as string | undefined;
  const isReasoning = logKind === "reasoning" || (!logKind && log.message === "AI reasoning...");
  const responseContent = log.details?.["responseContent"];
  const hasResponseContent = typeof responseContent === "string" && responseContent.length > 0;
  const hasOtherDetails = details
    ? Object.keys(details).some((key) => key !== "responseContent" && key !== "logKind")
    : false;
  const renderDetails = useCallback(
    () => (
      <pre className="mt-1 p-2 bg-neutral-800 rounded text-xs overflow-x-auto">
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
  const isStreamingEntry = logKind === "response" || logKind === "reasoning";
  const showMessageLabel = showHeader && !isStreamingEntry;

  return (
    <div key={`log-${log.id}-${index}`} className={`group ${isReasoning ? "opacity-60" : ""} ${spacingClass}`}>
      {showHeader && (
        <div className="text-gray-500 text-xs mb-0.5">
          {formatTime(log.timestamp)}
        </div>
      )}
      <div className={`min-w-0 ${isReasoning ? "text-gray-400 italic" : getLogLevelColor(log.level)}`}>
        {showMessageLabel && (
          <span className="break-words">{log.message}</span>
        )}
        {/* Show responseContent as proper text */}
        {hasResponseContent && (
          markdownEnabled ? (
            <div className={`mt-2 p-2 sm:p-3 bg-neutral-800 rounded ${isReasoning ? "italic" : ""}`}>
              <MarkdownRenderer content={responseContent as string} className="text-xs" dimmed={isReasoning} />
            </div>
          ) : (
            <div className={`mt-2 p-2 sm:p-3 bg-neutral-800 rounded whitespace-pre-wrap break-words text-xs leading-relaxed ${isReasoning ? "text-gray-400 italic" : "text-gray-200"}`}>
              {responseContent}
            </div>
          )
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
