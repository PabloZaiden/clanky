/**
 * MarkdownRenderer component for rendering markdown content.
 * Uses react-markdown for client-side rendering with GFM support.
 */

import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createContext, memo, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { useToast } from "@pablozaiden/webapp/web";
import { MermaidDiagram } from "./MermaidDiagram";
import { Button, CopyPathIcon } from "./common";
import type { TranscriptFileLinkContext } from "./log-viewer/types";
import {
  renderTranscriptTextNodes,
  resolveMarkdownFileLinkTarget,
  TranscriptInlineCode,
  TranscriptPathLink,
} from "./log-viewer/transcript-file-links";
import { writeTextToClipboard } from "../utils";

// react-markdown 10 no longer passes the legacy `inline` renderer prop, so
// block code is marked at its <pre> boundary instead.
const MarkdownCodeBlockContext = createContext(false);

function MarkdownPre({ children, node }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (
    code?.type === "element"
    && Array.isArray(code.properties["className"])
    && code.properties["className"].includes("language-mermaid")
  ) {
    const source = code.children.map((child) => child.type === "text" ? child.value : "").join("");
    return <MermaidDiagram source={source} />;
  }
  const codeText = code?.type === "element"
    ? code.children.map((child) => child.type === "text" ? child.value : "").join("")
    : null;
  return (
    <MarkdownCodeBlockContext.Provider value={true}>
      <div className="relative min-w-0 max-w-full">
        {codeText !== null && <MarkdownCodeBlockCopyButton codeText={codeText} />}
        <pre className="max-w-full overflow-x-auto rounded-lg bg-gray-100 px-4 pb-4 pt-10 text-sm text-gray-900 dark:bg-neutral-800 dark:text-gray-100">
          {children}
        </pre>
      </div>
    </MarkdownCodeBlockContext.Provider>
  );
}

function MarkdownCodeBlockCopyButton({ codeText }: { codeText: string }) {
  const toast = useToast();

  async function handleCopyCode(): Promise<void> {
    try {
      await writeTextToClipboard(codeText);
    } catch (error) {
      toast.error(`Failed to copy code to the clipboard: ${String(error)}`);
      return;
    }
    toast.success("Copied code to the clipboard");
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="absolute right-2 top-2 z-10 !h-7 !w-7 !min-h-7 !min-w-7 !p-1"
      aria-label="Copy code block"
      title="Copy code"
      onClick={() => void handleCopyCode()}
    >
      <span aria-hidden="true">
        <CopyPathIcon size="h-4 w-4" />
      </span>
    </Button>
  );
}

function MarkdownCode({
  children,
  className,
  fileLinkContext,
}: {
  children: ReactNode;
  className?: string;
  fileLinkContext?: TranscriptFileLinkContext;
}) {
  const isCodeBlock = useContext(MarkdownCodeBlockContext);

  if (!isCodeBlock) {
    return (
      <TranscriptInlineCode className={className} fileLinkContext={fileLinkContext}>
        {children}
      </TranscriptInlineCode>
    );
  }

  return (
    <code className={className}>
      {renderTranscriptTextNodes(children, fileLinkContext)}
    </code>
  );
}

export interface MarkdownRendererProps {
  /** Markdown content to render */
  content: string;
  /** Additional CSS classes for the container */
  className?: string;
  /** Whether to apply reduced opacity (for in-progress content) */
  dimmed?: boolean;
  /** Whether to display raw markdown text instead of rendered content */
  rawMode?: boolean;
  /** Optional chat/task-aware context for linking inline file paths. */
  fileLinkContext?: TranscriptFileLinkContext;
}

/**
 * Renders markdown content as React elements using react-markdown.
 * Supports GitHub Flavored Markdown features including tables, strikethrough,
 * task lists, autolinks, and Mermaid fenced code blocks.
 * 
 * When rawMode is true, displays the raw markdown text in a preformatted block.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = "",
  dimmed = false,
  rawMode = false,
  fileLinkContext,
}: MarkdownRendererProps) {
  if (!content) {
    return null;
  }

  // Raw mode: display raw markdown text in a preformatted block
  if (rawMode) {
      return (
        <div
          data-dimmed={dimmed ? "true" : "false"}
          className={`markdown-renderer min-w-0 ${dimmed ? "opacity-60" : ""} ${className}`.trim()}
        >
        <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-sm text-gray-900 dark:text-gray-100 [overflow-wrap:anywhere]">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <div
      data-dimmed={dimmed ? "true" : "false"}
      className={`markdown-renderer prose prose-sm dark:prose-invert min-w-0 max-w-full break-words [overflow-wrap:anywhere] [&_li]:break-words [&_p]:break-words [&_td]:break-words [&_th]:break-words ${dimmed ? "opacity-60" : ""} ${className}`.trim()}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Custom component overrides for consistent styling
          a: ({ href, children }) => {
            const target = href && fileLinkContext
              ? resolveMarkdownFileLinkTarget(href, fileLinkContext)
              : null;
            if (target && fileLinkContext) {
              return (
                <TranscriptPathLink
                  target={target}
                  fileLinkContext={fileLinkContext}
                  href={fileLinkContext.getFileHref(target)}
                >
                  {children}
                </TranscriptPathLink>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {children}
              </a>
            );
          },
          p: ({ children, className, ...props }) => (
            <p {...props} className={className}>
              {renderTranscriptTextNodes(children, fileLinkContext)}
            </p>
          ),
          li: ({ children, className, ...props }) => (
            <li {...props} className={className}>
              {renderTranscriptTextNodes(children, fileLinkContext)}
            </li>
          ),
          code: ({ children, className }) => (
            <MarkdownCode
              className={className}
              fileLinkContext={fileLinkContext}
            >
              {children}
            </MarkdownCode>
          ),
          pre: MarkdownPre,
          table: ({ children, className, ...props }) => (
            <div className="min-w-0 max-w-full overflow-x-auto">
              <table {...props} className={`markdown-table min-w-full w-fit max-w-none table-auto ${className ?? ""}`.trim()}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, className, ...props }) => (
            <th {...props} className={`markdown-table-cell whitespace-normal break-words ${className ?? ""}`.trim()}>
              {renderTranscriptTextNodes(children, fileLinkContext)}
            </th>
          ),
          td: ({ children, className, ...props }) => (
            <td {...props} className={`markdown-table-cell whitespace-normal break-words ${className ?? ""}`.trim()}>
              {renderTranscriptTextNodes(children, fileLinkContext)}
            </td>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
});
