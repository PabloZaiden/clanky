/**
 * Renders a Markdown Mermaid block without retaining obsolete async results.
 */
import { memo, useEffect, useState } from "react";
import { ErrorState, useTheme } from "@pablozaiden/webapp/web";
import { renderMermaid } from "./mermaid-renderer";

interface MermaidResult {
  source: string;
  theme: "light" | "dark";
  svg?: string;
  error?: string;
}

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const [result, setResult] = useState<MermaidResult | null>(null);
  const currentResult = result?.source === source && result.theme === resolvedTheme ? result : null;

  useEffect(() => {
    const controller = new AbortController();
    async function render(): Promise<void> {
      try {
        const svg = await renderMermaid({ source, theme: resolvedTheme, signal: controller.signal });
        if (!controller.signal.aborted) {
          setResult({ source, theme: resolvedTheme, svg });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setResult({ source, theme: resolvedTheme, error: String(error) });
        }
      }
    }
    void render();
    return () => controller.abort();
  }, [source, resolvedTheme]);

  return (
    <div className="not-prose my-4 min-w-0 max-w-full">
      {currentResult?.svg ? (
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="mermaid-diagram max-w-full overflow-x-auto rounded-lg bg-gray-50 p-4 dark:bg-neutral-800"
          dangerouslySetInnerHTML={{ __html: currentResult.svg }}
        />
      ) : (
        <>
          {currentResult?.error ? (
            <ErrorState title="Unable to render Mermaid diagram" description={currentResult.error} />
          ) : (
            <p role="status" className="text-xs text-gray-500 dark:text-gray-400">Rendering diagram...</p>
          )}
          <pre className="max-w-full overflow-x-auto rounded-lg bg-gray-100 p-4 text-sm dark:bg-neutral-800">
            <code>{source}</code>
          </pre>
        </>
      )}
    </div>
  );
});
