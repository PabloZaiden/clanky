import { memo, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import jsonLanguage from "highlight.js/lib/languages/json";
import { formatToolValue } from "./tool-inference";

let isJsonLanguageRegistered = false;

function ensureJsonLanguageRegistered(): void {
  if (isJsonLanguageRegistered) {
    return;
  }

  hljs.registerLanguage("json", jsonLanguage);
  isJsonLanguageRegistered = true;
}

function renderHighlightedJson(value: unknown): { text: string; highlightedHtml: string | null } {
  const text = formatToolValue(value);
  if (typeof value === "string" || typeof value === "undefined") {
    return { text, highlightedHtml: null };
  }

  ensureJsonLanguageRegistered();
  return {
    text,
    highlightedHtml: hljs.highlight(text, {
      language: "json",
      ignoreIllegals: true,
    }).value,
  };
}

const blockClassName = "overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-sky-100 bg-white p-3 font-mono text-xs text-gray-900 dark:border-white/10 dark:bg-black/20 dark:text-gray-100";

export const HighlightedJsonBlock = memo(function HighlightedJsonBlock({ value }: { value: unknown }) {
  const rendered = useMemo(() => renderHighlightedJson(value), [value]);

  if (!rendered.highlightedHtml) {
    return (
      <pre
        className={blockClassName}
        data-tool-value-block="true"
      >
        {rendered.text}
      </pre>
    );
  }

  return (
    <pre
      className={`${blockClassName} tool-json-highlight`}
      data-tool-value-block="true"
      data-tool-json-highlighted="true"
    >
      <code
        className="hljs language-json block whitespace-pre-wrap break-words bg-transparent p-0"
        dangerouslySetInnerHTML={{ __html: rendered.highlightedHtml }}
      />
    </pre>
  );
});
