import { memo, useCallback } from "react";
import { LazyDetails } from "./lazy-details";
import { LogEntryItem } from "./log-entry-item";
import { formatThoughtDuration, formatTime } from "./utils";
import type { ReasoningGroupEntryBase, TranscriptFileLinkContext } from "./types";
import { ThinkingIndicator } from "./thinking-indicator";

interface ReasoningGroupEntryProps {
  entry: ReasoningGroupEntryBase & {
    showTimestamp: boolean;
    showGroupHeader: boolean;
  };
  spacingClass: string;
  showActivityIndicator?: boolean;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
}

export const ReasoningGroupEntry = memo(function ReasoningGroupEntry({
  entry,
  spacingClass,
  showActivityIndicator = true,
  markdownEnabled,
  fileLinkContext,
}: ReasoningGroupEntryProps) {
  const summary = entry.isActive
    ? "Thinking…"
    : `Thought for ${formatThoughtDuration(entry.timestamp, entry.endedAt ?? entry.lastTimestamp)}`;
  const renderContent = useCallback(
    () => (
      <div className="space-y-2" data-reasoning-panel="true">
        {entry.logs.map((log, index) => (
          <LogEntryItem
            key={`reasoning-${log.id}`}
            data={log}
            showTimestamp={false}
            showGroupHeader={false}
            spacingClass={index === 0 ? "" : "mt-2"}
            markdownEnabled={markdownEnabled}
            fileLinkContext={fileLinkContext}
          />
        ))}
      </div>
    ),
    [entry.logs, fileLinkContext, markdownEnabled],
  );

  return (
    <div
      className={`group ${spacingClass}`.trim()}
      data-entry-type="reasoning-group"
      data-reasoning-active={entry.isActive ? "true" : "false"}
    >
      {entry.showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={entry.timestamp}>
          {formatTime(entry.timestamp)}
        </time>
      )}
      <LazyDetails
        summary={
          <ThinkingIndicator
            isActive={entry.isActive && showActivityIndicator}
            label="Thinking"
            className="transition hover:text-gray-600 dark:hover:text-white/48"
            dataReasoningSummary
          >
            {summary}
          </ThinkingIndicator>
        }
        defaultOpen={false}
        renderContent={renderContent}
        className="w-full"
        triggerClassName="w-full text-left"
        panelClassName="mt-2"
      />
    </div>
  );
});
