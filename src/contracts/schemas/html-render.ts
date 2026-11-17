import { z } from "zod";
import { HTML_MAX_FIT_HEIGHT } from "@/shared/html-render";

const source = {
  html: z.string().min(1).max(128_000).optional().describe("Self-contained HTML; pass exactly one of html or path."),
  path: z.string().min(1).max(16_384).optional().describe("HTML file on the current chat's execution host. Relative paths use its working directory."),
};
export const HtmlPreviewInputSchema = z.object({
  ...source,
  width: z.number().int().min(240).max(1600).default(728).describe("CSS pixels. Also inspect about 390px for phones."),
  appearance: z.enum(["light", "dark"]).default("dark"),
  offset: z.number().int().min(0).max(HTML_MAX_FIT_HEIGHT).default(0).describe("Vertical screenshot offset; use to inspect content below a clipped capture."),
}).strict();
export const HtmlRenderInputSchema = z.object({
  ...source,
  title: z.string().trim().min(1).max(200),
  height: z.number().int().min(80).max(HTML_MAX_FIT_HEIGHT).describe("Initial frame height in CSS pixels. Use contentHeight from html_preview, capped at 20000; the viewer then measures live height."),
}).strict();
export type HtmlSource = { html?: string; path?: string };
