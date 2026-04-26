import { memo, useCallback, useMemo, useState } from "react";
import type { ToolCallData } from "../../types";
import { getDiffFileStatusPresentation } from "../common/diff-file-status";
import { ImageViewerModal } from "../ImageViewerModal";
import { DiffPatchViewer } from "../loop-details/diff-patch-viewer";
import { HighlightedJsonBlock } from "./highlighted-json-block";
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
  fullWidth?: boolean;
}

const toolPanelClassName = "space-y-3 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-gray-900 sm:p-4 dark:border-sky-500/20 dark:bg-[#101826] dark:text-gray-100";

/** Renders text-like output content while preserving embedded newlines and tabs. */
function RenderedContent({ output }: { output: unknown }) {
  const content = getTextFromOutput(output) ?? formatToolValue(output);

  return (
    <pre
      className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-sky-100 bg-white p-3 font-mono text-xs text-gray-900 dark:border-white/10 dark:bg-black/20 dark:text-gray-100"
      data-tool-value-block="true"
    >
      {content}
    </pre>
  );
}

function hasMeaningfulToolValue(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
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
                <div className="rounded-b bg-gray-100 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-neutral-950 dark:text-gray-400">
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
              <dd className="min-w-0 break-words text-sm leading-6 text-gray-900 dark:text-gray-100">{row.value}</dd>
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
        <ul className="space-y-1 rounded-xl border border-sky-100 bg-white p-3 text-sm leading-6 text-gray-900 dark:border-white/10 dark:bg-black/20 dark:text-gray-100">
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
        <HighlightedJsonBlock value={block.value} />
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
      <HighlightedJsonBlock value={block.content} />
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

function ToolImagePreviewSection({
  tool,
}: {
  tool: ToolCallData;
}) {
  const imageExtras = tool.extras?.filter((extra) => extra.type === "image_preview") ?? [];
  const [selectedExtraId, setSelectedExtraId] = useState<string | null>(null);
  const selectedExtra = imageExtras.find((extra) => extra.id === selectedExtraId) ?? null;
  const selectedImage = useMemo(() => selectedExtra ? {
    src: `data:${selectedExtra.image.mimeType};base64,${selectedExtra.image.data}`,
    alt: selectedExtra.image.filename,
    title: selectedExtra.image.filename,
    description: `${Math.max(1, Math.round(selectedExtra.image.size / 1024))} KB`,
  } : null, [selectedExtra]);

  if (imageExtras.length === 0) {
    return null;
  }

  return (
    <>
      <div className="space-y-2" data-tool-block="image-preview">
        <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Preview</div>
        <div className="flex flex-wrap gap-2">
          {imageExtras.map((extra) => (
            <button
              key={extra.id}
              type="button"
              onClick={() => setSelectedExtraId(extra.id)}
              className="rounded-xl border border-sky-100 bg-white/90 p-1 text-left hover:border-sky-300 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:border-white/10 dark:bg-black/20 dark:hover:border-sky-400/60"
              aria-label={`View ${extra.image.filename}`}
            >
              <img
                src={`data:${extra.image.mimeType};base64,${extra.image.data}`}
                alt={extra.image.filename}
                className="h-20 w-20 rounded-lg object-cover"
              />
            </button>
          ))}
        </div>
      </div>
      <ImageViewerModal image={selectedImage} onClose={() => setSelectedExtraId(null)} />
    </>
  );
}

export const ToolEntry = memo(function ToolEntry({
  data: tool,
  timestamp,
  showTimestamp,
  spacingClass,
  toolPathDisplayRoot,
  fullWidth = false,
}: ToolEntryProps) {
  const meta = getToolMeta(tool, { pathDisplayRoot: toolPathDisplayRoot });
  const structuredDetails = useMemo(
    () => getStructuredToolDetails(tool, { pathDisplayRoot: toolPathDisplayRoot }),
    [tool, toolPathDisplayRoot]
  );
  const normalizedOutputBlocks = useMemo(() => {
    if (!structuredDetails || structuredDetails.outputBlocks.length !== 1) {
      return structuredDetails?.outputBlocks ?? [];
    }

    const [block] = structuredDetails.outputBlocks;
    if (!block?.title || block.title.toLowerCase() !== meta.outputLabel.toLowerCase()) {
      return structuredDetails.outputBlocks;
    }

    return [{ ...block, title: undefined } satisfies ToolDetailBlock];
  }, [structuredDetails, meta.outputLabel]);
  const toolSummaryClassName = "block text-sm leading-6 italic text-sky-700 dark:text-sky-300";

  const inputSummary = (
    <span className={toolSummaryClassName} data-tool-summary="true">{meta.summary}</span>
  );
  const hasMeaningfulInput = hasMeaningfulToolValue(tool.input);
  const hasOutput = hasMeaningfulToolValue(tool.output);

  const inputContent = structuredDetails && structuredDetails.inputBlocks.length > 0
    ? <ToolDetailSection blocks={structuredDetails.inputBlocks} />
    : <HighlightedJsonBlock value={tool.input} />;

  const outputContent = normalizedOutputBlocks.length > 0
    ? <ToolDetailSection blocks={normalizedOutputBlocks} />
    : meta.outputType === "text"
      ? <RenderedContent output={tool.output} />
      : <HighlightedJsonBlock value={tool.output} />;

  const renderInputContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-700/70 dark:text-sky-200/60">Input</div>
          {inputContent}
        </div>
        <ToolImagePreviewSection tool={tool} />
      </div>
    ),
    [inputContent, tool]
  );

  const renderOutputOnlyContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-700/70 dark:text-sky-200/60">{meta.outputLabel}</div>
          {outputContent}
        </div>
        <ToolImagePreviewSection tool={tool} />
      </div>
    ),
    [outputContent, meta.outputLabel, tool]
  );

  const renderCombinedContent = useCallback(
    () => (
      <div className={toolPanelClassName} data-tool-panel-tone="neutral">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-700/70 dark:text-sky-200/60">Input</div>
          {inputContent}
        </div>
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-sky-700/70 dark:text-sky-200/60">{meta.outputLabel}</div>
          {outputContent}
        </div>
        <ToolImagePreviewSection tool={tool} />
      </div>
    ),
    [inputContent, outputContent, meta.outputLabel, tool]
  );

  return (
    <div className={`group ${spacingClass}`} data-entry-type="tool" data-tool-kind={meta.kind}>
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className={fullWidth ? "min-w-0 w-full" : "min-w-0 max-w-[min(96%,72rem)]"}>
        {hasMeaningfulInput ? (
          <LazyDetails
            summary={inputSummary}
            renderContent={hasOutput ? renderCombinedContent : renderInputContent}
            className="w-full"
            triggerClassName="w-full text-left"
            panelClassName="mt-3"
          />
        ) : hasOutput ? (
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
