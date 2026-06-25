/**
 * Zod schemas for chat-related API requests.
 *
 * @module types/schemas/chat
 */

import { z } from "zod";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@/shared";
import { ModelConfigSchema } from "./model";
import { TaskNameSchema, MessageImageAttachmentsSchema } from "./task";
import { AgentProviderSchema } from "./workspace";

export const CreateChatRequestSchema = z.object({
  name: z.string().trim().max(100, "name cannot exceed 100 characters").optional(),
  workspaceId: z.string().min(1, "workspaceId is required"),
  model: ModelConfigSchema,
  useWorktree: z.boolean({ error: "useWorktree is required and must be a boolean (true or false)" }),
  autoApprovePermissions: z.boolean().default(true),
  baseBranch: z.string().min(1, "baseBranch must be non-empty when provided").optional(),
  quick: z.boolean().default(false),
});

export const CreateSshServerChatRequestSchema = z.object({
  name: z.string().trim().max(100, "name cannot exceed 100 characters").optional(),
  directory: z.string().trim().min(1, "directory is required"),
  model: ModelConfigSchema,
  autoApprovePermissions: z.boolean().default(true),
  credentialToken: z.string().trim().min(1).nullable().optional(),
});

export const ImportExistingChatRequestSchema = z.object({
  name: z.string().trim().max(100, "name cannot exceed 100 characters").optional(),
  workspaceId: z.string().min(1, "workspaceId is required"),
  model: ModelConfigSchema,
  sessionId: z.string().trim().min(1, "sessionId is required"),
  cwd: z.string().trim().min(1, "cwd must be non-empty when provided").optional(),
  autoApprovePermissions: z.boolean().default(true),
});

export const UpdateChatRequestSchema = z.object({
  name: TaskNameSchema.optional(),
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

export const ReplyToChatPermissionRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]),
});

export const ReconnectChatRequestSchema = z.object({
  credentialToken: z.string().trim().min(1).nullable().optional(),
}).default({});

export const DiscoverSshServerChatProvidersRequestSchema = z.object({
  credentialToken: z.string().trim().min(1, "credentialToken is required"),
});

export const DiscoverSshServerChatModelsRequestSchema = z.object({
  credentialToken: z.string().trim().min(1, "credentialToken is required"),
  providerID: AgentProviderSchema,
  directory: z.string().trim().min(1, "directory is required"),
});

export const SpawnCurrentPlanTaskRequestSchema = z.object({
  planFilePath: z.string().trim().optional(),
});
