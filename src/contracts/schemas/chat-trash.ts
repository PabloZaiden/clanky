import { z } from "zod";
import { DomainError } from "../../domain/domain-error";
import { decodeUtf8Base64Url, encodeJsonBase64Url } from "@/shared/encoding";

const ChatTrashCursorSchema = z.object({
  deletedAt: z.iso.datetime(),
  id: z.string().min(1).max(2048),
  timestampBoundary: z.enum(["inclusive", "exclusive"]).optional(),
});
type ChatTrashCursor = z.infer<typeof ChatTrashCursorSchema>;

export function decodeChatTrashCursor(cursor: string): ChatTrashCursor {
  try {
    return ChatTrashCursorSchema.parse(JSON.parse(decodeUtf8Base64Url(cursor)));
  } catch (cause) {
    throw new DomainError("invalid_trash_cursor", "Invalid Trash cursor", { cause });
  }
}

export function encodeChatTrashCursor(cursor: ChatTrashCursor): string {
  return encodeJsonBase64Url(cursor);
}

export const ChatTrashQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(2048).optional(),
  includePrivate: z.enum(["true", "false"]).default("true"),
});

export type ChatTrashQuery = z.infer<typeof ChatTrashQuerySchema>;

export const TrashedChatSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string().nullable(),
  origin: z.string(),
  isPrivate: z.boolean(),
  deletedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const PurgeChatTrashRequestSchema = z.object({}).strict();

export type PurgeChatTrashRequest = z.infer<typeof PurgeChatTrashRequestSchema>;

export const ChatTrashPageSchema = z.object({
  items: z.array(TrashedChatSchema),
  nextCursor: z.string().nullable(),
});

export const ChatTrashResultSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  failures: z.array(z.object({ chatId: z.string(), message: z.string() })).max(100),
});

export const EmptyChatTrashResponseSchema = ChatTrashResultSchema.extend({
  success: z.boolean(),
});

export type TrashedChat = z.infer<typeof TrashedChatSchema>;
export type ChatTrashPage = z.infer<typeof ChatTrashPageSchema>;
export type ChatTrashResult = z.infer<typeof ChatTrashResultSchema>;
