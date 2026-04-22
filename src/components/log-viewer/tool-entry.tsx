import { memo, useCallback } from "react";
import type { ToolCallData } from "../../types";
import { LazyDetails } from "./lazy-details";
import { formatTime } from "./utils";
import { formatToolValue, getTextFromOutput, getToolMeta } from "./tool-inference";

interface ToolEntryProps {
  data: ToolCallData;
  timestamp: string;
  showTimestamp: boolean;
  spacingClass: string;
  toolPathDisplayRoot?: string;
}

/** Renders text-like output content while preserving embedded newlines and tabs. */
function RenderedContent({ output }: { output: unknown }) {
  const content = getTextFromOutput(output) ?? formatToolValue(output);

  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-slate-100">
      {content}
    </pre>
  );
}

function ToolValueBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-slate-100">
      {formatToolValue(value)}
    </pre>
  );
}

export const ToolEntry = memo(function ToolEntry({
  data: tool,
  timestamp,
  showTimestamp,
  spacingClass,
  toolPathDisplayRoot,
}: ToolEntryProps) {
  const meta = getToolMeta(tool, { pathDisplayRoot: toolPathDisplayRoot });
  const toolSummaryClassName = "block text-sm leading-6 text-sky-300";

  const inputSummary = (
    <span className={toolSummaryClassName}>{meta.summary}</span>
  );

  const renderInputContent = useCallback(
    () => (
      <div className="space-y-3 rounded-2xl border border-sky-500/20 bg-[#101826] p-3 sm:p-4">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">Input</div>
          <ToolValueBlock value={tool.input} />
        </div>
      </div>
    ),
    [tool.input]
  );

  const renderOutputOnlyContent = useCallback(
    () => (
      <div className="space-y-3 rounded-2xl border border-sky-500/20 bg-[#101826] p-3 sm:p-4">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">{meta.outputLabel}</div>
        {meta.outputType === "text" ? (
          <RenderedContent output={tool.output} />
        ) : (
            <ToolValueBlock value={tool.output} />
        )}
        </div>
      </div>
    ),
    [tool.output, meta.outputLabel, meta.outputType]
  );

  const renderCombinedContent = useCallback(
    () => (
      <div className="space-y-3 rounded-2xl border border-sky-500/20 bg-[#101826] p-3 sm:p-4">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">Input</div>
          <ToolValueBlock value={tool.input} />
        </div>
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">{meta.outputLabel}</div>
          {meta.outputType === "text" ? (
            <RenderedContent output={tool.output} />
          ) : (
            <ToolValueBlock value={tool.output} />
          )}
        </div>
      </div>
    ),
    [tool.input, tool.output, meta.outputLabel, meta.outputType]
  );

  return (
    <div className={`group ${spacingClass}`} data-entry-type="tool">
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className="min-w-0 max-w-[min(92%,48rem)]">
        {tool.input != null ? (
          <LazyDetails
            summary={inputSummary}
            renderContent={tool.output != null ? renderCombinedContent : renderInputContent}
            className="w-full"
            triggerClassName="w-full text-left"
            panelClassName="mt-3"
          />
        ) : tool.output != null ? (
          <LazyDetails
            summary={inputSummary}
            renderContent={renderOutputOnlyContent}
            className="w-full"
            triggerClassName="w-full text-left"
            panelClassName="mt-3"
          />
        ) : (
          <span className={toolSummaryClassName}>{meta.summary}</span>
        )}
      </div>
    </div>
  );
});
