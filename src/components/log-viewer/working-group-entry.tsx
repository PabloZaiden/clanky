import { memo, useCallback, useMemo } from "react";
import { LazyDetails } from "./lazy-details";
import { ReasoningGroupEntry } from "./reasoning-group-entry";
import { ToolGroupEntry } from "./tool-group-entry";
import type { ToolCallData } from "@/shared";
import {
  annotateDisplayEntries,
  formatThoughtDuration,
  formatTime,
  getEntrySpacingClass,
} from "./utils";
import type {
  DisplayEntry,
  TranscriptFileLinkContext,
  WorkingGroupEntryBase,
} from "./types";

type WorkingChildDisplayEntry = Extract<
  DisplayEntry,
  { type: "tool-group" | "reasoning-group" }
>;

interface WorkingGroupEntryProps {
  entry: WorkingGroupEntryBase & {
    showTimestamp: boolean;
    showGroupHeader: boolean;
  };
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  toolPathDisplayRoot?: string;
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
}

export const WorkingGroupEntry = memo(function WorkingGroupEntry({
  entry,
  spacingClass,
  markdownEnabled,
  fileLinkContext,
  toolPathDisplayRoot,
  onLoadToolDetails,
}: WorkingGroupEntryProps) {
  const summary = entry.isActive
    ? "Working…"
    : `Worked for ${formatThoughtDuration(entry.timestamp, entry.endedAt ?? entry.lastTimestamp)}`;
  const groupedChildEntries = useMemo(
    () => annotateDisplayEntries(entry.entries).filter(
      (childEntry): childEntry is WorkingChildDisplayEntry =>
        childEntry.type === "tool-group" || childEntry.type === "reasoning-group",
    ),
    [entry.entries],
  );
  const renderContent = useCallback(
    () => (
      <div data-working-group-panel="true">
        {groupedChildEntries.map((childEntry, index) => {
          const spacingClass = getEntrySpacingClass(
            childEntry,
            groupedChildEntries[index - 1],
          );

          if (childEntry.type === "tool-group") {
            return (
              <ToolGroupEntry
                key={`working-tool-group-${childEntry.id}`}
                entry={childEntry}
                spacingClass={spacingClass}
                toolPathDisplayRoot={toolPathDisplayRoot}
                onLoadToolDetails={onLoadToolDetails}
              />
            );
          }

          return (
            <ReasoningGroupEntry
              key={`working-reasoning-group-${childEntry.id}`}
              entry={childEntry}
              spacingClass={spacingClass}
              markdownEnabled={markdownEnabled}
              fileLinkContext={fileLinkContext}
            />
          );
        })}
      </div>
    ),
    [
      fileLinkContext,
      groupedChildEntries,
      markdownEnabled,
      onLoadToolDetails,
      toolPathDisplayRoot,
    ],
  );

  return (
    <div
      className={`group ${spacingClass}`.trim()}
      data-entry-type="working-group"
      data-working-active={entry.isActive ? "true" : "false"}
    >
      {entry.showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={entry.timestamp}>
          {formatTime(entry.timestamp)}
        </time>
      )}
      <LazyDetails
        summary={
          <span
            className="inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 transition hover:text-gray-600 dark:text-white/28 dark:hover:text-white/48"
            data-working-summary="true"
          >
            {summary}
          </span>
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
