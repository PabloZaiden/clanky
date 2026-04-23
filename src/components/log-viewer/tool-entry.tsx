import { memo, useCallback, useMemo } from "react";
import type { ToolCallData } from "../../types";
import { getDiffFileStatusPresentation } from "../common/diff-file-status";
import { DiffPatchViewer } from "../loop-details/diff-patch-viewer";
import { LazyDetails } from "./lazy-details";
import { formatTime } from "./utils";
import {
  formatToolValue,
  getStructuredToolDetails,
  getTextFromOutput,
  getToolMeta,
  type ToolDetailBlock,
} from "./tool-inference";

interface ToolEntryProps {
  data: ToolCallData;
  timestamp: string;
  showTimestamp: boolean;
  spacingClass: string;
  toolPathDisplayRoot?: string;
}

const toolPanelClassName = "space-y-3 rounded-2xl border border-sky-500/20 bg-[#101826] p-3 sm:p-4";

/** Renders text-like output content while preserving embedded newlines and tabs. */
function RenderedContent({ output }: { output: unknown }) {
  const content = getTextFromOutput(output) ?? formatToolValue(output);

  return (
    <pre
      className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-gray-100"
      data-tool-value-block="true"
    >
      {content}
    </pre>
  );
}

function ToolValueBlock({ value }: { value: unknown }) {
  return (
    <pre
      className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs text-gray-100"
      data-tool-value-block="true"
    >
      {formatToolValue(value)}
    </pre>
  );
}

function ApplyPatchBlockView({ block }: { block: Extract<ToolDetailBlock, { type: "patch" }> }) {
  return (
    <div className="space-y-2" data-tool-block="patch">
      {block.title && (
        <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
      )}
      <div className="space-y-2">
        {block.files.map((file, index) => {
          const statusPresentation = getDiffFileStatusPresentation(file.status);

          return (
            <div
              key={`${file.oldPath ?? file.path}-${file.path}-${index}`}
              className="overflow-hidden rounded bg-gray-50 text-xs sm:text-sm dark:bg-neutral-900"
              data-tool-patch-file="true"
              data-tool-patch-status={file.status}
            >
              <div className="flex items-center gap-2 p-2 text-left sm:gap-3">
                <span className={`font-medium ${statusPresentation.className}`}>{statusPresentation.symbol}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-gray-900 dark:text-gray-100">
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                <span className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                  <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
                  {" "}
                  <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                </span>
              </div>
              {file.patch ? (
                <DiffPatchViewer patch={file.patch} />
              ) : (
                <div className="rounded-b bg-neutral-950 px-3 py-2 font-mono text-xs text-gray-400">
                  {file.status === "deleted" ? "File deleted by patch." : "No diff hunks in patch."}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolDetailBlockView({ block }: { block: ToolDetailBlock }) {
  if (block.type === "rows") {
    return (
      <div className="space-y-2" data-tool-block="rows">
        {block.title && (
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
        )}
        <dl className="space-y-2">
          {block.rows.map((row, index) => (
            <div key={`${row.label}-${row.value}-${index}`} className="grid gap-1 sm:grid-cols-[9rem,minmax(0,1fr)] sm:gap-3">
              <dt className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{row.label}</dt>
              <dd className="min-w-0 break-words text-sm leading-6 text-gray-100">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  if (block.type === "list") {
    return (
      <div className="space-y-2" data-tool-block="list">
        {block.title && (
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
        )}
        <ul className="space-y-1 rounded-xl border border-white/10 bg-black/20 p-3 text-sm leading-6 text-gray-100">
          {block.items.map((item, index) => (
            <li key={`${item}-${index}`} className="break-words">{item}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (block.type === "json") {
    return (
      <div className="space-y-2" data-tool-block="json">
        {block.title && (
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
        )}
        <ToolValueBlock value={block.value} />
      </div>
    );
  }

  if (block.type === "text") {
    return (
      <div className="space-y-2" data-tool-block="text">
        {block.title && (
          <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
        )}
        <RenderedContent output={block.content} />
      </div>
    );
  }

  if (block.type === "patch") {
    return <ApplyPatchBlockView block={block} />;
  }

  return (
    <div className="space-y-2" data-tool-block="code">
      {block.title && (
        <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">{block.title}</div>
      )}
      <ToolValueBlock value={block.content} />
    </div>
  );
}

function ToolDetailSection({ blocks }: { blocks: ToolDetailBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => (
        <ToolDetailBlockView key={`${block.type}-${block.title ?? "untitled"}-${index}`} block={block} />
      ))}
    </div>
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
  const structuredDetails = useMemo(
    () => getStructuredToolDetails(tool, { pathDisplayRoot: toolPathDisplayRoot }),
    [tool, toolPathDisplayRoot]
  );
  const toolSummaryClassName = "block text-sm leading-6 italic text-sky-300";

  const inputSummary = (
    <span className={toolSummaryClassName} data-tool-summary="true">{meta.summary}</span>
  );

  const inputContent = structuredDetails && structuredDetails.inputBlocks.length > 0
    ? <ToolDetailSection blocks={structuredDetails.inputBlocks} />
    : <ToolValueBlock value={tool.input} />;

  const outputContent = structuredDetails && structuredDetails.outputBlocks.length > 0
    ? <ToolDetailSection blocks={structuredDetails.outputBlocks} />
    : meta.outputType === "text"
      ? <RenderedContent output={tool.output} />
      : <ToolValueBlock value={tool.output} />;

  const renderInputContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">Input</div>
          {inputContent}
        </div>
      </div>
    ),
    [inputContent]
  );

  const renderOutputOnlyContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">{meta.outputLabel}</div>
          {outputContent}
        </div>
      </div>
    ),
    [outputContent, meta.outputLabel]
  );

  const renderCombinedContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">Input</div>
          {inputContent}
        </div>
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-200/60">{meta.outputLabel}</div>
          {outputContent}
        </div>
      </div>
    ),
    [inputContent, outputContent, meta.outputLabel]
  );

  return (
    <div className={`group ${spacingClass}`} data-entry-type="tool">
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className="min-w-0 max-w-[min(96%,72rem)]">
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
