import { memo, useCallback, useMemo } from "react";
import { LazyDetails } from "./lazy-details";
import { ReasoningGroupEntry } from "./reasoning-group-entry";
import { ToolGroupEntry } from "./tool-group-entry";
import { ActivityIndicator } from "./activity-indicator";
import { HarnessToolActivity } from "../harness-activity";
import type { ToolCallData } from "@/shared";
import {
  annotateDisplayEntries,
  formatThoughtDuration,
  formatTime,
  getEntrySpacingClass,
  getWorkingGroupToolSummary,
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
    showDate: boolean;
    showGroupHeader: boolean;
  };
  localDayKey: number;
  spacingClass: string;
  markdownEnabled: boolean;
  fileLinkContext?: TranscriptFileLinkContext;
  toolPathDisplayRoot?: string;
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
}

export const WorkingGroupEntry = memo(function WorkingGroupEntry({
  entry,
  localDayKey,
  spacingClass,
  markdownEnabled,
  fileLinkContext,
  toolPathDisplayRoot,
  onLoadToolDetails,
}: WorkingGroupEntryProps) {
  const toolSummary = getWorkingGroupToolSummary(entry.entries, toolPathDisplayRoot);
  const summary = entry.isActive
    ? `Thinking and using ${toolSummary}…`
    : `Worked for ${formatThoughtDuration(entry.timestamp, entry.endedAt ?? entry.lastTimestamp)} - thought and used ${toolSummary}`;
  const groupedChildEntries = useMemo(
    () => annotateDisplayEntries(entry.entries, localDayKey).filter(
      (childEntry): childEntry is WorkingChildDisplayEntry =>
        childEntry.type === "tool-group" || childEntry.type === "reasoning-group",
    ),
    [entry.entries, localDayKey],
  );
  const renderContent = useCallback(
    () => (
      <div data-working-group-panel="true">
        {groupedChildEntries.map((childEntry, index) => {
          const spacingClass = getEntrySpacingClass(
            childEntry,
            groupedChildEntries[index - 1],
          );
          const childEntryForRender =
            index === 0 && entry.showTimestamp
              ? { ...childEntry, showTimestamp: false }
              : childEntry;

          if (childEntryForRender.type === "tool-group") {
            return (
              <ToolGroupEntry
                key={`working-tool-group-${childEntryForRender.id}`}
                entry={childEntryForRender}
                localDayKey={localDayKey}
                spacingClass={spacingClass}
                showActivityIndicator={false}
                toolPathDisplayRoot={toolPathDisplayRoot}
                onLoadToolDetails={onLoadToolDetails}
              />
            );
          }

          return (
            <ReasoningGroupEntry
              key={`working-reasoning-group-${childEntryForRender.id}`}
              entry={childEntryForRender}
              spacingClass={spacingClass}
              showActivityIndicator={false}
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
      localDayKey,
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
          {formatTime(entry.timestamp, entry.showDate)}
        </time>
      )}
      <LazyDetails
        summary={
          <ActivityIndicator
            active={entry.isActive}
            label="Working"
            className="rounded-md py-0.5 text-left text-base text-gray-400 transition hover:text-gray-600 dark:text-white/28 dark:hover:text-white/48"
            data-working-summary="true"
          >
            {summary}
          </ActivityIndicator>
        }
        defaultOpen={false}
        renderContent={renderContent}
        className="w-full"
        triggerClassName="w-full text-left"
        panelClassName="mt-2"
      />
      <HarnessToolActivity toolIds={groupedChildEntries.flatMap((child) => child.type === "tool-group" ? child.tools.map((tool) => tool.id) : [])} />
    </div>
  );
});
