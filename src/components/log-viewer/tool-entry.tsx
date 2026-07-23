import { memo, useCallback, useMemo, useState } from "react";
import type { ToolCallData, ToolCallDisplayData } from "@/shared";
import { isToolCallSummary } from "@/shared/tool-call";
import { getDiffFileStatusPresentation } from "../common/diff-file-status";
import { ImageViewerModal } from "../ImageViewerModal";
import { DiffPatchViewer } from "../task-details/diff-patch-viewer";
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
  data: ToolCallDisplayData;
  timestamp: string;
  showTimestamp: boolean;
  spacingClass: string;
  toolPathDisplayRoot?: string;
  fullWidth?: boolean;
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
}

const toolPanelClassName = "space-y-3 text-gray-900 dark:text-gray-100";

/** Renders text-like output content, highlighting it when it is valid JSON. */
function RenderedContent({ output }: { output: unknown }) {
  const content = getTextFromOutput(output) ?? formatToolValue(output);
  return <HighlightedJsonBlock value={content} />;
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
        <ul className="space-y-1 rounded-md border border-gray-200 bg-gray-50/80 p-3 text-sm leading-6 text-gray-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-100">
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
              className="rounded-md border border-gray-200 bg-gray-50/80 p-1 text-left hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-white/20 dark:focus:ring-white/15"
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
  onLoadToolDetails,
}: ToolEntryProps) {
  const isSummary = isToolCallSummary(tool);
  const [details, setDetails] = useState<ToolCallData | null>(() => isSummary ? null : tool);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const activeTool = details ?? (isSummary ? null : tool);
  const meta = getToolMeta(activeTool ?? tool, { pathDisplayRoot: toolPathDisplayRoot });
  const structuredDetails = useMemo(
    () => activeTool
      ? getStructuredToolDetails(activeTool, { pathDisplayRoot: toolPathDisplayRoot })
      : null,
    [activeTool, toolPathDisplayRoot]
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
  const statusClassName = tool.status === "failed"
    ? "text-red-600 dark:text-red-400"
    : tool.status === "completed"
      ? "text-green-600 dark:text-green-400"
      : "text-amber-600 dark:text-amber-400";
  const shouldShowStatus = tool.status !== "completed";
  const toolSummaryClassName = "inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-xs leading-5 text-gray-400 transition hover:text-gray-600 dark:text-white/28 dark:hover:text-white/48";

  const inputSummary = (
    <span className={toolSummaryClassName} data-tool-summary="true">
      {shouldShowStatus && (
        <>
          <span className={`shrink-0 font-medium ${statusClassName}`}>{tool.status}</span>
          <span className="shrink-0 text-gray-300 dark:text-gray-600">/</span>
        </>
      )}
      <span className="min-w-0 truncate">{meta.summary}</span>
    </span>
  );
  const hasMeaningfulInput = activeTool ? hasMeaningfulToolValue(activeTool.input) : false;
  const hasOutput = activeTool ? hasMeaningfulToolValue(activeTool.output) : false;

  const inputContent = activeTool
    ? structuredDetails && structuredDetails.inputBlocks.length > 0
      ? <ToolDetailSection blocks={structuredDetails.inputBlocks} />
      : <HighlightedJsonBlock value={activeTool.input} />
    : null;

  const outputContent = activeTool
    ? normalizedOutputBlocks.length > 0
      ? <ToolDetailSection blocks={normalizedOutputBlocks} />
      : meta.outputType === "text"
        ? <RenderedContent output={activeTool.output} />
        : <HighlightedJsonBlock value={activeTool.output} />
    : null;

  const loadDetails = useCallback(async () => {
    if (!isSummary || details || detailsLoading) {
      return;
    }
    if (!onLoadToolDetails) {
      setDetailsError("Tool call details are unavailable");
      return;
    }

    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const loaded = await onLoadToolDetails(tool.id);
      if (!loaded) {
        throw new Error("Tool call details were not found");
      }
      setDetails(loaded);
    } catch (error) {
      setDetailsError(String(error));
    } finally {
      setDetailsLoading(false);
    }
  }, [details, detailsLoading, isSummary, onLoadToolDetails, tool.id]);

  const renderDetailsContent = useCallback(
    () => {
      if (!activeTool) {
        return (
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {detailsLoading ? "Loading tool details…" : detailsError ?? "Tool details are unavailable"}
          </div>
        );
      }

      return (
        <div className={toolPanelClassName} data-tool-panel-tone="neutral">
          {hasMeaningfulInput && (
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Input</div>
              {inputContent}
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">{meta.outputLabel}</div>
              {outputContent}
            </div>
          )}
          {!hasMeaningfulInput && !hasOutput && (
            <div className="text-sm text-gray-500 dark:text-gray-400">No additional details.</div>
          )}
          <ToolImagePreviewSection tool={activeTool} />
        </div>
      );
    },
    [
      activeTool,
      detailsError,
      detailsLoading,
      hasMeaningfulInput,
      hasOutput,
      inputContent,
      meta.outputLabel,
      outputContent,
    ],
  );

  return (
    <div className={`group ${spacingClass}`} data-entry-type="tool" data-tool-kind={meta.kind}>
      {showTimestamp && (
        <time className="mb-1 block text-[11px] text-gray-500" dateTime={timestamp}>
          {formatTime(timestamp)}
        </time>
      )}
      <div className={fullWidth ? "min-w-0 w-full" : "min-w-0 max-w-[min(96%,72rem)]"}>
        {isSummary || hasMeaningfulInput || hasOutput ? (
          <LazyDetails
            summary={inputSummary}
            renderContent={renderDetailsContent}
            onOpen={() => void loadDetails()}
            className="w-full"
            triggerClassName="w-full text-left"
            panelClassName="mt-2"
          />
        ) : (
          <span className={toolSummaryClassName}>
            {shouldShowStatus && (
              <>
                <span className={`shrink-0 font-medium ${statusClassName}`}>{tool.status}</span>
                <span className="shrink-0 text-gray-300 dark:text-gray-600">/</span>
              </>
            )}
            <span className="min-w-0 truncate">{meta.summary}</span>
          </span>
        )}
      </div>
    </div>
  );
});
