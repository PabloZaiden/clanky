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
}

/** Renders text-like output content while preserving embedded newlines and tabs. */
function RenderedContent({ output }: { output: unknown }) {
  const content = getTextFromOutput(output) ?? formatToolValue(output);

  return (
    <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}

export const ToolEntry = memo(function ToolEntry({ data: tool, timestamp, showTimestamp, spacingClass }: ToolEntryProps) {
  const meta = getToolMeta(tool);
  const toolSummaryClassName = "text-[11px] italic leading-relaxed text-gray-400";

  const inputSummary = (
    <span className={toolSummaryClassName}>{meta.summary}</span>
  );

  const renderInputContent = useCallback(
    () => (
      <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
        {formatToolValue(tool.input)}
      </pre>
    ),
    [tool.input]
  );

  const renderOutputOnlyContent = useCallback(
    () => (
      <>
        <div className="text-gray-500 text-xs mt-1">{meta.outputLabel}</div>
        {meta.outputType === "text" ? (
          <RenderedContent output={tool.output} />
        ) : (
          <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
            {formatToolValue(tool.output)}
          </pre>
        )}
      </>
    ),
    [tool.output, meta.outputLabel, meta.outputType]
  );

  const renderCombinedContent = useCallback(
    () => (
      <>
        <div className="text-gray-500 text-xs mt-1">Input</div>
        <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
          {formatToolValue(tool.input)}
        </pre>
        <div className="text-gray-500 text-xs mt-2">{meta.outputLabel}</div>
        {meta.outputType === "text" ? (
          <RenderedContent output={tool.output} />
        ) : (
          <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
            {formatToolValue(tool.output)}
          </pre>
        )}
      </>
    ),
    [tool.input, tool.output, meta.outputLabel, meta.outputType]
  );

  return (
    <div className={`group py-1 ${spacingClass}`}>
      {showTimestamp && (
        <time className="text-gray-500 text-xs mb-0.5 block" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className="min-w-0">
        {tool.input != null ? (
          <LazyDetails
            summary={inputSummary}
            renderContent={tool.output != null ? renderCombinedContent : renderInputContent}
          />
        ) : tool.output != null ? (
          <LazyDetails summary={inputSummary} renderContent={renderOutputOnlyContent} />
        ) : (
          <span className={toolSummaryClassName}>{meta.summary}</span>
        )}
      </div>
    </div>
  );
});
