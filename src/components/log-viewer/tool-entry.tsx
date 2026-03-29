import { memo, useCallback } from "react";
import type { ToolCallData } from "../../types";
import { formatTime } from "./utils";
import { LazyDetails } from "./lazy-details";

interface ToolEntryProps {
  data: ToolCallData;
  timestamp: string;
  showHeader: boolean;
  spacingClass: string;
  index: number;
}

interface ToolMeta {
  /** Human-readable one-line summary of what the tool is doing. */
  summary: string;
  /** Label for the output section (e.g. "Output", "Result", "Done"). */
  outputLabel: string;
  /**
   * How to render the output:
   * - "text": extract the `content` field and render as preformatted text (escape chars honoured)
   * - "json": render the raw output object as collapsed JSON
   */
  outputType: "text" | "json";
}

function getStringField(input: unknown, key: string): string | undefined {
  if (input !== null && typeof input === "object" && key in (input as Record<string, unknown>)) {
    const val = (input as Record<string, unknown>)[key];
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function getPathField(input: unknown): string | undefined {
  return getStringField(input, "path") ?? getStringField(input, "filePath");
}

function hasField(input: unknown, key: string): boolean {
  return input !== null && typeof input === "object" && key in (input as Record<string, unknown>);
}

/** Maps a tool call to display metadata. Falls back to generic rendering for unknown tools. */
function getToolMeta(tool: ToolCallData): ToolMeta {
  const name = tool.name.toLowerCase();

  if (name === "execute" || name === "bash") {
    const cmdPreview = getStringField(tool.input, "command");
    const desc =
      getStringField(tool.input, "description") ??
      (cmdPreview ? `${cmdPreview.slice(0, 60)}…` : name);
    return { summary: desc, outputLabel: "Output", outputType: "text" };
  }

  if (name === "read" || name === "view") {
    const path = getPathField(tool.input) ?? "file";
    return { summary: `Read ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "edit") {
    const path = getPathField(tool.input) ?? "file";
    return { summary: `Edit ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "create") {
    const path = getPathField(tool.input) ?? name;
    return { summary: `Create ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "grep") {
    const pattern = getStringField(tool.input, "pattern") ?? "";
    const path = getPathField(tool.input);
    const summary = path ? `Search for '${pattern}' in ${path}` : `Search for '${pattern}'`;
    return { summary, outputLabel: "Result", outputType: "text" };
  }

  if (name === "glob") {
    const pattern = getStringField(tool.input, "pattern") ?? "";
    return { summary: `Find files matching '${pattern}'`, outputLabel: "Result", outputType: "text" };
  }

  // SQL tool — also catches "other" tool calls that carry a "query" field
  if (name === "sql" || name === "other" || hasField(tool.input, "query")) {
    const desc = getStringField(tool.input, "description") ?? "SQL query";
    return { summary: desc, outputLabel: "Done", outputType: "json" };
  }

  // Unknown / generic tool
  return { summary: tool.name, outputLabel: "Output", outputType: "json" };
}

/** Renders output content as preformatted text, honouring embedded newlines/tabs. */
function RenderedContent({ output }: { output: unknown }) {
  let content: string;
  if (typeof output === "string") {
    content = output;
  } else if (output !== null && typeof output === "object" && "content" in (output as Record<string, unknown>)) {
    const raw = (output as Record<string, unknown>)["content"];
    content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  } else {
    content = JSON.stringify(output, null, 2);
  }

  return (
    <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}

export const ToolEntry = memo(function ToolEntry({ data: tool, timestamp, showHeader, spacingClass, index }: ToolEntryProps) {
  const meta = getToolMeta(tool);

  /** Rich ReactNode used as the <summary> of the input <details> element. */
  const inputSummary = (
    <span>
      <span className="text-gray-300">{meta.summary}</span>
    </span>
  );

  const renderInputContent = useCallback(
    () => (
      <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto">
        {JSON.stringify(tool.input, null, 2)}
      </pre>
    ),
    [tool.input]
  );

  /** Renders output only (used when input is absent but output is present). */
  const renderOutputOnlyContent = useCallback(
    () => (
      <>
        <div className="text-gray-500 text-xs mt-1">{meta.outputLabel}</div>
        {meta.outputType === "text" ? (
          <RenderedContent output={tool.output} />
        ) : (
          <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto">
            {typeof tool.output === "string"
              ? tool.output
              : JSON.stringify(tool.output, null, 2)}
          </pre>
        )}
      </>
    ),
    [tool.output, meta.outputLabel, meta.outputType]
  );

  /** Renders input + output together inside a single collapsible section. */
  const renderCombinedContent = useCallback(
    () => (
      <>
        <div className="text-gray-500 text-xs mt-1">Input</div>
        <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
        <div className="text-gray-500 text-xs mt-2">{meta.outputLabel}</div>
        {meta.outputType === "text" ? (
          <RenderedContent output={tool.output} />
        ) : (
          <pre className="mt-1 rounded bg-neutral-800 p-2 font-mono text-xs overflow-x-auto">
            {typeof tool.output === "string"
              ? tool.output
              : JSON.stringify(tool.output, null, 2)}
          </pre>
        )}
      </>
    ),
    [tool.input, tool.output, meta.outputLabel, meta.outputType]
  );

  return (
    <div key={`tool-${tool.id}-${index}`} className={`group ${spacingClass}`}>
      {showHeader && (
        <div className="text-gray-500 text-xs mb-0.5">
          {formatTime(timestamp)}
        </div>
      )}
      <div className="min-w-0">
        {tool.input != null ? (
          // Input exists: wrap in collapsible; include output in same section if completed
          <LazyDetails
            summary={inputSummary}
            renderContent={tool.output != null ? renderCombinedContent : renderInputContent}
          />
        ) : tool.output != null ? (
          // No input but output present: still collapse output
          <LazyDetails summary={inputSummary} renderContent={renderOutputOnlyContent} />
        ) : (
          // Neither input nor output yet (pending/running): plain header
          <span className="text-xs">
            <span className="text-gray-300">{meta.summary}</span>
          </span>
        )}
      </div>
    </div>
  );
});
