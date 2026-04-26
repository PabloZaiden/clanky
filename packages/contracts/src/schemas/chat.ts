/**
 * Zod schemas for chat-related API requests.
 *
 * @module types/schemas/chat
 */

import { z } from "zod";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@ralpher/shared";
import { ModelConfigSchema } from "./model";
import { LoopNameSchema, MessageImageAttachmentsSchema } from "./loop";

export const CreateChatRequestSchema = z.object({
  name: LoopNameSchema,
  workspaceId: z.string().min(1, "workspaceId is required"),
  model: ModelConfigSchema,
  useWorktree: z.boolean({ error: "useWorktree is required and must be a boolean (true or false)" }),
  baseBranch: z.string().min(1, "baseBranch is required"),
});

export const UpdateChatRequestSchema = z.object({
  name: LoopNameSchema.optional(),
  model: ModelConfigSchema.optional(),
  baseBranch: z.string().optional(),
  useWorktree: z.boolean().optional(),
});

export const SendChatMessageRequestSchema = z.object({
  message: z.string().nullable().optional().transform((value) => value ?? null),
  attachments: MessageImageAttachmentsSchema.default([]),
}).superRefine((value, ctx) => {
  const hasMessage = typeof value.message === "string" && value.message.trim().length > 0;
  const hasAttachments = Array.isArray(value.attachments) && value.attachments.length > 0;

  if (!hasMessage && !hasAttachments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message or attachments are required",
      path: ["message"],
    });
  }
});

export const InterruptChatRequestSchema = z.object({
  reason: z.string().trim().min(1, "reason is required").default(DEFAULT_CHAT_INTERRUPT_REASON),
});
