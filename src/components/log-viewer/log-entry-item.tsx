import { memo, useCallback } from "react";
import type { TaskLogEntry } from "@/shared";
import { LazyDetails } from "./lazy-details";
import type { TranscriptFileLinkContext } from "./types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { TranscriptTextContent } from "./transcript-file-links";
import { formatTime, getLogLevelColor, isReasoningLogEntry } from "./utils";

interface LogEntryItemProps {
  data: TaskLogEntry;
  showTimestamp: boolean;
  showGroupHeader: boolean;
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
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
  fileLinkContext,
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
      <pre className="mt-1 overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-900 dark:bg-neutral-800 dark:text-gray-100">
        {JSON.stringify(getOtherDetails(details!), null, 2)}
      </pre>
    ),
    [details]
  );

  if (isReasoning && !hasResponseContent && !hasOtherDetails) {
    return null;
  }

  const showMessageLabel = showGroupHeader && !isReasoning;
  const textColorClassName = isReasoning
    ? "text-gray-500 dark:text-gray-400"
    : log.level === "agent"
      ? "text-gray-900 dark:text-white"
      : getLogLevelColor(log.level);
  const logTone = isReasoning
    ? "reasoning"
    : log.level === "agent"
      ? "agent"
      : log.level;
  const widthClassName = isReasoning
    ? "min-w-0 w-full"
    : "min-w-0 max-w-[min(96%,72rem)]";

  return (
    <div className={`group ${spacingClass}`.trim()} data-log-kind={logKind ?? "default"}>
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
            {markdownEnabled ? (
              <MarkdownRenderer
                content={responseContent as string}
                className="text-sm leading-7 text-gray-500 dark:text-gray-400"
                dimmed
                fileLinkContext={fileLinkContext}
              />
            ) : (
              <TranscriptTextContent
                content={responseContent as string}
                className="text-sm leading-7 whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400"
                dimmed
                fileLinkContext={fileLinkContext}
              />
            )}
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
