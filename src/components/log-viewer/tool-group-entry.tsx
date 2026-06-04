import { memo, useId, useMemo, useState } from "react";
import type { DisplayEntry, ToolGroupEntryBase } from "./types";
import { annotateDisplayEntries, formatTime, getEntrySpacingClass } from "./utils";
import { ToolEntry } from "./tool-entry";
import { getToolMeta, type InferredToolKind } from "./tool-inference";

interface ToolGroupEntryProps {
  entry: ToolGroupEntryBase & {
    showTimestamp: boolean;
    showGroupHeader: boolean;
  };
  spacingClass: string;
  toolPathDisplayRoot?: string;
}

function truncateToolSummary(summary: string): string {
  const maxLength = 72;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}...` : summary;
}

function getPluralToolLabel(kind: InferredToolKind): string {
  switch (kind) {
    case "view":
      return "reads";
    case "edit":
      return "edits";
    case "bash":
      return "commands";
    case "rg":
    case "glob":
      return "searches";
    case "apply_patch":
      return "patches";
    case "read_bash":
      return "shell reads";
    case "write_bash":
      return "shell writes";
    case "sql":
      return "queries";
    case "github_mcp":
      return "GitHub calls";
    case "web_fetch":
      return "fetches";
    case "todo":
      return "todo updates";
    case "skill":
      return "skill loads";
    case "rubber_duck":
      return "agent calls";
    case "unknown":
      return "tools";
  }
}

function getToolGroupSummary(entry: ToolGroupEntryBase, toolPathDisplayRoot?: string): string {
  const metas = entry.tools.map((tool) => getToolMeta(tool, { pathDisplayRoot: toolPathDisplayRoot }));
  if (metas.length > 1 && metas.every((meta) => meta.kind === metas[0]?.kind)) {
    return `${metas.length} ${getPluralToolLabel(metas[0]!.kind)}`;
  }

  const summaries = metas
    .map((meta) => truncateToolSummary(meta.summary))
    .filter((summary, index, allSummaries) => summary.length > 0 && allSummaries.indexOf(summary) === index);

  if (summaries.length === 0) {
    return "Tool activity";
  }

  if (summaries.length <= 2) {
    return summaries.join(", ");
  }

  return `${summaries.slice(0, 2).join(", ")} +${summaries.length - 2} more`;
}

export const ToolGroupEntry = memo(function ToolGroupEntry({
  entry,
  spacingClass,
  toolPathDisplayRoot,
}: ToolGroupEntryProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const panelId = useId();
  const labelId = useId();
  const toolCount = entry.tools.length;
  const toolCallCountLabel = `${toolCount} tool call${toolCount === 1 ? "" : "s"}`;
  const groupSummary = useMemo(
    () => getToolGroupSummary(entry, toolPathDisplayRoot),
    [entry, toolPathDisplayRoot]
  );
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
      <div className="min-w-0">
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-xs text-gray-400 transition hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:text-white/28 dark:hover:text-white/48 dark:focus:ring-white/15"
          aria-expanded={isExpanded}
          aria-controls={panelId}
          id={labelId}
          onClick={() => setIsExpanded((current) => !current)}
          data-tool-group-toggle="true"
        >
          <span className="shrink-0 font-medium text-gray-500 dark:text-white/42">{toolCallCountLabel}</span>
          <span className="min-w-0 truncate">- {groupSummary}</span>
        </button>
        <div
          hidden={!isExpanded}
          id={panelId}
          role="region"
          aria-labelledby={labelId}
          className="mt-0.5 space-y-1.5"
          data-tool-group-panel="true"
        >
          {groupedToolEntries.map((groupedTool, index) => (
            <ToolEntry
              key={`tool-${groupedTool.data.id}`}
              data={groupedTool.data}
              timestamp={groupedTool.timestamp}
              showTimestamp={index !== 0 && groupedTool.showTimestamp}
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
