import { memo, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import jsonLanguage from "highlight.js/lib/languages/json";
import { formatJsonString, formatToolValue } from "./tool-inference";

const jsonHighlightLanguage = "json";
const isJsonHighlightingAvailable = initializeJsonHighlighting();

function initializeJsonHighlighting(): boolean {
  if (hljs.getLanguage(jsonHighlightLanguage)) {
    return true;
  }

  try {
    hljs.registerLanguage(jsonHighlightLanguage, jsonLanguage);
    return true;
  } catch {
    return false;
  }
}

function getRenderableJson(value: unknown): { text: string; canHighlight: boolean } {
  if (typeof value === "undefined") {
    return { text: formatToolValue(value), canHighlight: false };
  }

  if (typeof value !== "string") {
    return { text: formatToolValue(value), canHighlight: true };
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return { text: value, canHighlight: false };
  }

  const formattedJson = formatJsonString(trimmedValue);
  if (!formattedJson) {
    return { text: value, canHighlight: false };
  }

  return {
    text: formattedJson,
    canHighlight: true,
  };
}

function renderHighlightedJson(value: unknown): { text: string; highlightedHtml: string | null } {
  const renderable = getRenderableJson(value);
  if (!renderable.canHighlight) {
    return { text: renderable.text, highlightedHtml: null };
  }

  if (!isJsonHighlightingAvailable) {
    return { text: renderable.text, highlightedHtml: null };
  }

  try {
    return {
      text: renderable.text,
      highlightedHtml: hljs.highlight(renderable.text, {
        language: jsonHighlightLanguage,
        ignoreIllegals: true,
      }).value,
    };
  } catch {
    return { text: renderable.text, highlightedHtml: null };
  }
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
