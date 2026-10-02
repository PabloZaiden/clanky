/**
 * Serializes Mermaid's global configuration and removes cancelled pending work.
 */
import type { Mermaid, MermaidConfig } from "mermaid";

interface MermaidRenderRequest {
  id: string;
  source: string;
  theme: "light" | "dark";
  signal: AbortSignal;
  resolve: (svg: string) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

let mermaidPromise: Promise<Mermaid> | null = null;
const pendingRenders = new Map<string, MermaidRenderRequest>();
let rendering = false;
const MAX_MERMAID_TEXT_SIZE = 50_000;

async function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  try {
    return await mermaidPromise;
  } catch (error) {
    mermaidPromise = null;
    throw error;
  }
}

async function renderDiagram(request: MermaidRenderRequest): Promise<string> {
  request.signal.throwIfAborted();
  if (request.source.length > MAX_MERMAID_TEXT_SIZE) {
    throw new RangeError(`Mermaid diagrams are limited to ${MAX_MERMAID_TEXT_SIZE} characters.`);
  }
  const mermaid = await loadMermaid();
  request.signal.throwIfAborted();
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_TEXT_SIZE,
    logLevel: 5,
    theme: request.theme === "dark" ? "dark" : "default",
    fontFamily: "sans-serif",
    htmlLabels: false,
    secure: [
      "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
      "suppressErrorRendering", "dompurifyConfig", "theme", "themeVariables",
      "themeCSS", "fontFamily", "htmlLabels", "logLevel",
    ],
  };
  mermaid.initialize(config);
  const container = document.createElement("div");
  container.className = "mermaid-measurement";
  container.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(container);
  try {
    // Strict mode sanitizes the resulting SVG with Mermaid's DOMPurify.
    // Do not bind diagram callbacks or allow source directives to change security.
    const { svg } = await mermaid.render(request.id, request.source, container);
    request.signal.throwIfAborted();
    return svg;
  } finally {
    container.remove();
  }
}

async function drainRenders(): Promise<void> {
  if (rendering) {
    return;
  }
  rendering = true;
  try {
    for (const [id, request] of pendingRenders) {
      pendingRenders.delete(id);
      try {
        request.resolve(await renderDiagram(request));
      } catch (error) {
        request.reject(error);
      } finally {
        request.signal.removeEventListener("abort", request.onAbort);
      }
    }
  } finally {
    rendering = false;
  }
}

export function renderMermaid({
  source,
  theme,
  signal,
}: {
  source: string;
  theme: "light" | "dark";
  signal: AbortSignal;
}): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const id = `clanky-mermaid-${crypto.randomUUID()}`;
    const onAbort = () => {
      pendingRenders.delete(id);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pendingRenders.set(id, { id, source, theme, signal, resolve, reject, onAbort });
    // Each mounted diagram owns at most one pending request; effect cleanup
    // removes superseded streaming fragments instead of accumulating a history.
    void drainRenders();
  });
}
