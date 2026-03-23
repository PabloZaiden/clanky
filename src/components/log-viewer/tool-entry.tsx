import { memo, useCallback } from "react";
import type { ReactNode } from "react";
import type { ToolCallData } from "../../types";
import { formatTime, getToolStatusColor } from "./utils";
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
    return { summary: `Executing: ${desc}`, outputLabel: "Output", outputType: "text" };
  }

  if (name === "read" || name === "view") {
    const path = getStringField(tool.input, "path") ?? name;
    return { summary: `Read ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "edit") {
    const path = getStringField(tool.input, "path") ?? name;
    return { summary: `Edit ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "create") {
    const path = getStringField(tool.input, "path") ?? name;
    return { summary: `Create ${path}`, outputLabel: "Result", outputType: "text" };
  }

  if (name === "grep") {
    const pattern = getStringField(tool.input, "pattern") ?? "";
    const path = getStringField(tool.input, "path");
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
    return { summary: `Executing: ${desc}`, outputLabel: "Done", outputType: "json" };
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
    <pre className="mt-1 p-2 bg-neutral-800 rounded text-xs overflow-x-auto whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}

export const ToolEntry = memo(function ToolEntry({ data: tool, timestamp, showHeader, spacingClass, index }: ToolEntryProps) {
  const meta = getToolMeta(tool);
  const statusColor = getToolStatusColor(tool.status);

  const statusIcon: ReactNode = (
    <span className={`${statusColor} mr-1`}>
      {tool.status === "running" && <span className="inline-block animate-spin mr-1">⟳</span>}
      {tool.status === "completed" && "✓"}
      {tool.status === "failed" && "✗"}
      {tool.status === "pending" && "○"}
    </span>
  );

  /** Rich ReactNode used as the <summary> of the input <details> element. */
  const inputSummary: ReactNode = (
    <span>
      {statusIcon}
      <span className="text-gray-300">{meta.summary}</span>
    </span>
  );

  const renderInputContent = useCallback(
    () => (
      <pre className="mt-1 p-2 bg-neutral-800 rounded text-xs overflow-x-auto">
        {JSON.stringify(tool.input, null, 2)}
      </pre>
    ),
    [tool.input]
  );

  const renderOutputContent = useCallback(
    () => (
      <pre className="mt-1 p-2 bg-neutral-800 rounded text-xs overflow-x-auto">
        {typeof tool.output === "string"
          ? tool.output
          : JSON.stringify(tool.output, null, 2)}
      </pre>
    ),
    [tool.output]
  );

  const showToolHeader = showHeader || tool.input != null || tool.output != null;

  return (
    <div key={`tool-${tool.id}-${index}`} className={`group ${spacingClass}`}>
      {showHeader && (
        <div className="text-gray-500 text-xs mb-0.5">
          {formatTime(timestamp)}
        </div>
      )}
      <div className="min-w-0">
        {showToolHeader && (
          tool.input != null ? (
            // Input exists: wrap header + input JSON in a collapsible <details>
            <LazyDetails summary={inputSummary} renderContent={renderInputContent} />
          ) : (
            // No input yet (pending/running): show plain header without collapse
            <span className="text-xs">
              {statusIcon}
              <span className="text-gray-300">{meta.summary}</span>
            </span>
          )
        )}

        {/* Output section */}
        {tool.output != null && (
          meta.outputType === "text" ? (
            <div className="mt-1 ml-3">
              <div className="text-gray-500 text-xs">{meta.outputLabel}</div>
              <RenderedContent output={tool.output} />
            </div>
          ) : (
            <div className="ml-3">
              <LazyDetails summary={meta.outputLabel} renderContent={renderOutputContent} />
            </div>
          )
        )}
      </div>
    </div>
  );
});
