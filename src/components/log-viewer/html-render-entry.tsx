import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ErrorState, useTheme } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { HTML_MAX_FIT_HEIGHT, htmlThemeVariables, type HtmlRenderReference } from "@/shared/html-render";
import { useViewportVisibility } from "./use-viewport-visibility";

export function HtmlRenderEntry({ reference }: { reference: HtmlRenderReference }) {
  const { resolvedTheme } = useTheme();
  const { ref, visible } = useViewportVisibility<HTMLDivElement>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(reference.height);
  const [expanded, setExpanded] = useState(false);
  const sendTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage({
      type: "clanky-html-theme", appearance: resolvedTheme, variables: htmlThemeVariables(resolvedTheme),
    }, "*");
  }, [resolvedTheme]);

  useEffect(() => {
    if (!visible || html !== null || error !== null) return;
    const controller = new AbortController();
    void apiRequest(`/api/chats/${encodeURIComponent(reference.chatId)}/html-renders/${encodeURIComponent(reference.id)}`, {
      responseType: "text", signal: controller.signal, action: "Load HTML artifact",
    }).then((result) => {
      if (!controller.signal.aborted) setHtml(result);
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => controller.abort();
  }, [visible, html, error, reference.chatId, reference.id]);

  useEffect(sendTheme, [sendTheme, html]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "clanky-html-size" && Number.isFinite(event.data.height)) {
        setHeight(Math.max(80, Math.min(HTML_MAX_FIT_HEIGHT, Math.ceil(event.data.height))));
      } else if (event.data.type === "clanky-html-link" && typeof event.data.url === "string" && URL.canParse(event.data.url)) {
        const url = new URL(event.data.url);
        if (["https:", "http:", "mailto:", "tel:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  return (
    <div ref={ref} className="my-3 min-w-0 w-full" data-html-render={reference.id}>
      {error ? (
        <ErrorState title="Unable to load HTML artifact" description={error}
          action={<Button size="sm" onClick={() => setError(null)}>Reload</Button>} />
      ) : html === null ? (
        <p role="status" className="text-sm text-gray-500">Loading visual...</p>
      ) : (
        <>
          <iframe
            ref={frame}
            title={reference.title}
            sandbox="allow-scripts allow-forms"
            srcDoc={html}
            onLoad={sendTheme}
            className="block w-full border-0 bg-transparent"
            style={{ height: Math.min(height, expanded ? HTML_MAX_FIT_HEIGHT : 800) }}
          />
          {height > 800 && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
              {expanded ? "Collapse visual" : "Expand visual"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
