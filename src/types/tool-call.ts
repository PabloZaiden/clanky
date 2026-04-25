import type { MessageImageAttachment } from "./message-attachments";

export interface ToolCallImagePreviewExtra {
  id: string;
  type: "image_preview";
  image: MessageImageAttachment;
  sourcePath?: string;
}

export type ToolCallExtra = ToolCallImagePreviewExtra;

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  timestamp: string;
  extras?: ToolCallExtra[];
}

export function upsertToolCallExtra(
  extras: ToolCallExtra[] | undefined,
  extra: ToolCallExtra,
): ToolCallExtra[] {
  const existing = extras ?? [];
  const index = existing.findIndex((entry) => entry.id === extra.id);
  if (index >= 0) {
    return existing.map((entry, entryIndex) => entryIndex === index ? extra : entry);
  }
  return [...existing, extra];
}

