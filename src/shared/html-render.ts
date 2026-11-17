import { z } from "zod";

export const HTML_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const HTML_MAX_FIT_HEIGHT = 20_000;
export const HtmlRenderReferenceSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().min(1).max(500),
  title: z.string().min(1).max(200),
  height: z.number().int().min(80).max(HTML_MAX_FIT_HEIGHT),
}).strict();
export type HtmlRenderReference = z.infer<typeof HtmlRenderReferenceSchema>;

export function isHtmlToolName(name: string): boolean {
  return /(?:^|[_.])clanky_html_(?:preview|render)$/.test(name);
}

export function htmlToolSummaryInput(name: string, value: unknown): unknown {
  if (!isHtmlToolName(name)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "html"));
}

export function htmlThemeVariables(appearance: "light" | "dark"): Record<string, string> {
  const dark = appearance === "dark";
  return {
    "--background": "transparent", "--foreground": dark ? "#f5f5f5" : "#171717",
    "--card": dark ? "#262626" : "#f5f5f5", "--muted": dark ? "#303030" : "#e5e5e5",
    "--muted-foreground": dark ? "#a3a3a3" : "#525252", "--border": dark ? "#404040" : "#d4d4d4",
    "--accent": dark ? "#60a5fa" : "#2563eb", "--accent-foreground": dark ? "#171717" : "#ffffff",
    "--warning": dark ? "#fbbf24" : "#b45309", "--destructive": dark ? "#f87171" : "#b91c1c",
    "--success": dark ? "#34d399" : "#047857",
    "--chart-1": dark ? "#60a5fa" : "#2563eb", "--chart-2": dark ? "#2dd4bf" : "#0f766e",
    "--chart-3": dark ? "#fbbf24" : "#b45309", "--chart-4": dark ? "#c084fc" : "#7e22ce",
    "--chart-5": dark ? "#fb7185" : "#be123c", "--chart-6": dark ? "#a3e635" : "#4d7c0f",
    "--radius": "0.625rem", "--font-sans": '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    "--font-mono": 'ui-monospace,"SFMono-Regular",Consolas,monospace',
  };
}

export const HTML_THEME_GUIDE = `Use injected CSS variables, not fixed theme colors: ${Object.keys(htmlThemeVariables("dark")).join(", ")}. The base sheet sets text, font, and a transparent background. For canvas or script-rendered colors, redraw on the window's clanky:theme-change event.`;
export const HTML_LAYOUT_GUIDE = "The frame follows the message-column width, about 360px on phones and wider on desktop. Use fluid widths and responsive columns that stack; wrap long text and keep images within their containers. Leave html, body, and the outer container transparent, without an outer card, banner title, border, or side padding. Clanky supplies an 8px gutter. Let content set height; do not use vh/svh/lvh/dvh or height:100% on html/body. Charts may use explicit pixel heights.";

export function bootstrapHtml(html: string): string {
  const variables = JSON.stringify(htmlThemeVariables("dark"));
  const bootstrap = `<style>
:root{${Object.entries(htmlThemeVariables("dark")).map(([k, v]) => `${k}:${v}`).join(";")}}
html{padding:8px;box-sizing:border-box}
*,*:before,*:after{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--foreground);font-family:var(--font-sans)}
img,video,svg{max-width:100%}img,video{height:auto}body{overflow-wrap:anywhere}
</style><script>(() => {
  const initial = ${variables};
  let last = 0;
  let queued = false;
  const send = () => {
    queued = false;
    const height = Math.ceil(Math.max(document.body?.scrollHeight || 0, document.body?.getBoundingClientRect().height || 0) + 16);
    if (height !== last) {
      last = height;
      parent.postMessage({ type: "clanky-html-size", height }, "*");
    }
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(send);
    }
  };
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "clanky-html-theme") return;
    document.documentElement.style.colorScheme = event.data.appearance === "dark" ? "dark" : "light";
    for (const [key, value] of Object.entries(event.data.variables || initial)) {
      if (key.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(key, value);
    }
    dispatchEvent(new Event("clanky:theme-change"));
    schedule();
  });
  addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(schedule).observe(document.body);
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    document.fonts.ready.then(schedule);
    schedule();
  });
  addEventListener("load", schedule);
  addEventListener("resize", schedule);
  document.addEventListener("click", event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return;
    event.preventDefault();
    parent.postMessage({ type: "clanky-html-link", url: url.href }, "*");
  });
})();</script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`);
}
