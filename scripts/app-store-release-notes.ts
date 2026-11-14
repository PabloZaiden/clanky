import { z } from "zod";

const start = "<!-- app-store-whats-new:start -->";
const end = "<!-- app-store-whats-new:end -->";

export const appStoreWhatsNewSchema = z.string().trim()
  .min(1, "App Store What's New must not be empty.")
  .max(4000, "App Store What's New must not exceed 4000 characters.")
  .refine(text => !text.includes(start) && !text.includes(end),
    "App Store What's New must not contain reserved release-note markers.");

export function formatAppStoreReleaseNotes(whatsNew: string): string {
  return `## App Store What's New\n\n${start}\n${appStoreWhatsNewSchema.parse(whatsNew)}\n${end}\n\n`;
}

export function readAppStoreReleaseNotes(body: string): string {
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (first < 0 || last < first || body.indexOf(start, first + start.length) !== -1
    || body.indexOf(end, last + end.length) !== -1) {
    throw new Error("Missing or ambiguous App Store What's New section. Prepare it with bun run release or complete the draft's release notes in App Store Connect.");
  }
  return appStoreWhatsNewSchema.parse(body.slice(first + start.length, last));
}
