import { z } from "zod";
import { HTML_MAX_FIT_HEIGHT } from "@/shared/html-render";

const source = {
  html: z.string().min(1).max(128_000).optional().describe("Self-contained HTML; pass exactly one of html or path."),
  path: z.string().min(1).max(16_384).optional().describe("HTML file on the current chat's execution host. Relative paths use its working directory."),
};
export const HtmlRenderInputSchema = z.object({
  ...source,
  title: z.string().trim().min(1).max(200),
  height: z.number().int().min(80).max(HTML_MAX_FIT_HEIGHT).describe("Estimated initial frame height in CSS pixels, at most 20000. The viewer then measures and adjusts the live height."),
}).strict();
export type HtmlSource = { html?: string; path?: string };
