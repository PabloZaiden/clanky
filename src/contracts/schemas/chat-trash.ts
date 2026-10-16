import { z } from "zod";

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
