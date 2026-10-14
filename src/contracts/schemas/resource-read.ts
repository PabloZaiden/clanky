/**
 * Client-neutral bounded representations of the existing resource operations.
 */
import { z } from "zod";

export const ReadSectionSchema = z.enum([
  "details", "questions", "permissions", "inputs", "activity", "prompt",
  "content", "output", "plan", "diff", "models", "providers", "files",
  "directories", "branches", "jobs", "runs", "agents", "templates", "addresses",
  "items", "entries", "sessions", "servers", "workspaces", "chats", "tasks",
  "workers", "enrollments", "activities", "variants", "previews", "nodes",
  "grants", "candidates", "issues", "comments", "logs",
]);

export const CollectionReadOptionsSchema = z.object({
  view: z.literal("compact").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  maxBytes: z.coerce.number().int().min(1024).max(16_384).optional(),
  section: ReadSectionSchema.optional(),
  item: z.string().min(1).max(128).optional(),
});

export const ConversationReadOptionsSchema = CollectionReadOptionsSchema.extend({
  view: z.enum(["compact", "conversation"]).optional(),
  range: z.enum(["earliest", "latest"]).optional(),
});

export const WorkCollectionReadOptionsSchema = CollectionReadOptionsSchema.extend({
  workspaceId: z.string().min(1).max(500).optional(),
  name: z.string().trim().min(1).max(500).optional(),
  status: z.string().min(1).max(100).optional(),
  needsInput: z.enum(["true", "false"]).optional(),
  order: z.enum(["created", "activity"]).optional(),
});

export const OperationResponseOptionsSchema = CollectionReadOptionsSchema.pick({ view: true, maxBytes: true });

export const ResourcePageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type ResourceReadOptions = z.infer<typeof ConversationReadOptionsSchema>
  & Partial<Omit<z.infer<typeof WorkCollectionReadOptionsSchema>, "view">>;
export type ReadSection = z.infer<typeof ReadSectionSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  context?: Record<string, unknown>;
}

export interface ContentPart {
  path: Array<string | number>;
  value: unknown;
  offset: number;
  complete: boolean;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  timestamp: string;
  content: string;
  offset: number;
  complete: boolean;
  delivery?: string;
  attachments?: number;
}
