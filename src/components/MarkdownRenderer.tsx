/**
 * MarkdownRenderer component for rendering markdown content.
 * Uses react-markdown for client-side rendering with GFM support.
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownRendererProps {
  /** Markdown content to render */
  content: string;
  /** Additional CSS classes for the container */
  className?: string;
  /** Whether to apply reduced opacity (for in-progress content) */
  dimmed?: boolean;
  /** Whether to display raw markdown text instead of rendered content */
  rawMode?: boolean;
}

/**
 * Renders markdown content as React elements using react-markdown.
 * Supports GitHub Flavored Markdown features including tables, strikethrough,
 * task lists, and autolinks.
 * 
 * When rawMode is true, displays the raw markdown text in a preformatted block.
 */
export function MarkdownRenderer({ content, className = "", dimmed = false, rawMode = false }: MarkdownRendererProps) {
  if (!content) {
    return null;
  }

  // Raw mode: display raw markdown text in a preformatted block
  if (rawMode) {
    return (
      <div
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
      className={`markdown-renderer prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere] [&_li]:break-words [&_p]:break-words [&_td]:break-words [&_th]:break-words ${dimmed ? "opacity-60" : ""} ${className}`.trim()}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Custom component overrides for consistent styling
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            // Check if this is inline code or a code block
            const isInline = !className;
            if (isInline) {
              return (
                <code className="break-all rounded bg-gray-100 px-1.5 py-0.5 font-mono text-sm dark:bg-neutral-800">
                  {children}
                </code>
              );
            }
            return <code className={className}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="max-w-full overflow-x-auto rounded-lg bg-gray-100 p-4 text-sm dark:bg-neutral-800">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
