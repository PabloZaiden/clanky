/**
 * MarkdownRenderer component for rendering markdown content.
 * Uses react-markdown for client-side rendering with GFM support.
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createContext, useContext, type ReactNode } from "react";
import type { TranscriptFileLinkContext } from "./log-viewer/types";
import {
  renderTranscriptTextNodes,
  resolveMarkdownFileLinkTarget,
  TranscriptInlineCode,
  TranscriptPathLink,
} from "./log-viewer/transcript-file-links";

// react-markdown 10 no longer passes the legacy `inline` renderer prop, so
// block code is marked at its <pre> boundary instead.
const MarkdownCodeBlockContext = createContext(false);

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
 * task lists, and autolinks.
 * 
 * When rawMode is true, displays the raw markdown text in a preformatted block.
 */
export function MarkdownRenderer({
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
          pre: ({ children }) => (
            <MarkdownCodeBlockContext.Provider value={true}>
              <pre className="max-w-full overflow-x-auto rounded-lg bg-gray-100 p-4 text-sm dark:bg-neutral-800">
                {children}
              </pre>
            </MarkdownCodeBlockContext.Provider>
          ),
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
}
