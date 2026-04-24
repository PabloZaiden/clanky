import { memo, useMemo, useState } from "react";
import type { DisplayEntry, ToolGroupEntryBase } from "./types";
import { annotateDisplayEntries, formatTime, getEntrySpacingClass } from "./utils";
import { ToolEntry } from "./tool-entry";

interface ToolGroupEntryProps {
  entry: ToolGroupEntryBase & {
    showTimestamp: boolean;
    showGroupHeader: boolean;
  };
  spacingClass: string;
  toolPathDisplayRoot?: string;
}

export const ToolGroupEntry = memo(function ToolGroupEntry({
  entry,
  spacingClass,
  toolPathDisplayRoot,
}: ToolGroupEntryProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const groupedToolEntries = useMemo(
    () => annotateDisplayEntries(
      entry.tools.map((tool) => ({
        type: "tool" as const,
        data: tool,
        timestamp: tool.timestamp,
      }))
    ).filter((groupedTool): groupedTool is Extract<DisplayEntry, { type: "tool" }> => groupedTool.type === "tool"),
    [entry.tools]
  );

  return (
    <div className={`group ${spacingClass}`} data-entry-type="tool-group">
      {entry.showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={entry.timestamp}>
          {formatTime(entry.timestamp)}
        </time>
      )}
      <div className="overflow-hidden rounded-2xl border border-sky-500/25 bg-[#0e1522] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-sky-100 transition hover:bg-white/5"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((current) => !current)}
          data-tool-group-toggle="true"
        >
          <span className="font-medium">Tool calls</span>
          <span className="text-xs uppercase tracking-[0.18em] text-sky-200/70">
            {isExpanded ? "Collapse" : "Expand"}
          </span>
        </button>
        <div hidden={!isExpanded} className="border-t border-white/8 px-3 py-3 sm:px-4" data-tool-group-panel="true">
          {groupedToolEntries.map((groupedTool, index) => (
            <ToolEntry
              key={`tool-${groupedTool.data.id}`}
              data={groupedTool.data}
              timestamp={groupedTool.timestamp}
              showTimestamp={entry.showTimestamp ? index !== 0 && groupedTool.showTimestamp : groupedTool.showTimestamp}
              spacingClass={getEntrySpacingClass(groupedTool, groupedToolEntries[index - 1])}
              toolPathDisplayRoot={toolPathDisplayRoot}
              fullWidth
            />
          ))}
        </div>
      </div>
    </div>
  );
});
