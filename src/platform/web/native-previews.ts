import { z } from "zod";

const previewTargetSchema = z.object({
  kind: z.enum(["workspace", "server"]),
  reference: z.string().min(1),
});

export const nativePreviewSchema = z.object({
  id: z.string().uuid(),
  previewId: z.string().optional(),
  target: previewTargetSchema,
  port: z.number().int().min(1).max(65535),
  path: z.string(),
  protocol: z.enum(["http", "https"]),
  status: z.enum(["starting", "active", "interrupted"]),
  url: z.string().url().optional(),
  error: z.string().optional(),
});

export const nativePreviewListSchema = z.array(nativePreviewSchema);
export type NativePreview = z.infer<typeof nativePreviewSchema>;

interface NativePreviewBridge {
  platform: "ios" | "macos";
  postMessage(message:
    | { type: "list" | "reset" }
    | { type: "open" | "close"; id: string }
    | {
      type: "start";
      target: NativePreview["target"];
      port: number;
      path: string;
      protocol: "http" | "https";
      socketUrl: string;
    }
  ): Promise<unknown>;
}

declare global {
  interface Window {
    clankyPreviews?: NativePreviewBridge;
  }
}

export async function resetNativePreviews(): Promise<void> {
  if (window.clankyPreviews) {
    z.literal(true).parse(await window.clankyPreviews.postMessage({ type: "reset" }));
  }
}

export async function nativePreviewAction(type: "open" | "close", id: string): Promise<void> {
  if (!window.clankyPreviews) throw new Error("Update the native app to manage local previews.");
  z.literal(true).parse(await window.clankyPreviews.postMessage({ type, id }));
}
