/**
 * Zod schemas for scheduled automations.
 *
 * Automations execute recurring headless chat-style prompts for a workspace.
 */

import { z } from "zod";
import { isValidIanaTimeZone } from "@/shared";
import { ModelConfigSchema } from "./model";
import { TaskNameSchema, MessageAttachmentsSchema } from "./task";
import { CollaborationResourceIdSchema } from "./collaboration";

export const AutomationScheduleIntervalUnitSchema = z.enum(["minutes", "hours", "days"]);

const IanaTimezoneSchema = z.string().trim().min(1, "timezone is required").refine(
  isValidIanaTimeZone,
  { message: "timezone must be a valid IANA timezone" },
);

export const AutomationScheduleIntervalSchema = z.object({
  value: z.number().int().positive("interval value must be greater than 0"),
  unit: AutomationScheduleIntervalUnitSchema,
});

export const AutomationScheduleSchema = z.object({
  startAtLocal: z.string().trim().min(1, "startAtLocal is required"),
  timezone: IanaTimezoneSchema,
  interval: AutomationScheduleIntervalSchema,
  nextRunAt: z.string().datetime().optional(),
});

export const AutomationTransferScheduleSchema = AutomationScheduleSchema.omit({
  nextRunAt: true,
});

export const AutomationTransferConfigSchema = z.object({
  name: TaskNameSchema,
  prompt: z.string().trim().min(1, "prompt is required"),
  code: z.string().nullable().optional(),
  model: ModelConfigSchema,
  baseBranch: z.string().trim().min(1, "baseBranch must be non-empty when provided").optional(),
  useWorktree: z.boolean(),
  schedule: AutomationTransferScheduleSchema,
});

export const AutomationTransferPayloadSchema = z.object({
  format: z.literal("clanky-automation"),
  version: z.literal(1),
  automation: AutomationTransferConfigSchema,
});

export const CreateAutomationRequestSchema = z.object({
  name: TaskNameSchema,
  workspaceId: z.string().min(1, "workspaceId is required"),
  prompt: z.string().trim().min(1, "prompt is required"),
  code: z.string().nullable().optional(),
  model: ModelConfigSchema,
  baseBranch: z.string().trim().min(1, "baseBranch must be non-empty when provided").optional(),
  useWorktree: z.boolean({ error: "useWorktree is required and must be a boolean (true or false)" }),
  schedule: AutomationScheduleSchema,
  enabled: z.boolean().default(true),
});

export const UpdateAutomationRequestSchema = z.object({
  name: TaskNameSchema.optional(),
  prompt: z.string().trim().min(1, "prompt cannot be empty").optional(),
  code: z.string().nullable().optional(),
  model: ModelConfigSchema.optional(),
  baseBranch: z.string().trim().min(1, "baseBranch must be non-empty when provided").nullable().optional(),
  useWorktree: z.boolean().optional(),
  schedule: AutomationScheduleSchema.optional(),
  enabled: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
});

export const GenerateAutomationCodeRequestSchema = z.object({
  name: TaskNameSchema.optional(),
  prompt: z.string().optional(),
  previousCode: z.string().optional(),
  workspaceId: z.string().min(1).optional(),
  model: ModelConfigSchema.optional(),
  chatId: CollaborationResourceIdSchema.optional(),
  generationMode: z.enum(["initial", "follow_up"]).optional(),
  message: z.string().trim().min(1).optional(),
  attachments: MessageAttachmentsSchema.default([]),
});

export const PrepareGenerateAutomationCodeRequestSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  model: ModelConfigSchema.optional(),
});

export const TestAutomationCodeRequestSchema = z.object({
  name: TaskNameSchema.optional(),
  prompt: z.string().optional().default(""),
  code: z.string().trim().min(1, "code is required"),
  workspaceId: z.string().min(1),
  model: ModelConfigSchema,
  baseBranch: z.string().trim().min(1).optional(),
  useWorktree: z.boolean().default(false),
  testRunId: z.string().uuid().optional(),
});

export const RunAutomationRequestSchema = z.object({
  attachments: MessageAttachmentsSchema.default([]),
}).default({ attachments: [] });

export const DeleteAutomationRunsRequestSchema = z.object({
  before: z.string().datetime().optional(),
  includeCompleted: z.boolean().default(true),
  includeFailed: z.boolean().default(true),
  includeSkipped: z.boolean().default(true),
  includeInterrupted: z.boolean().default(true),
  includeCancelled: z.boolean().default(true),
}).default({
  includeCompleted: true,
  includeFailed: true,
  includeSkipped: true,
  includeInterrupted: true,
  includeCancelled: true,
});

export const AutomationRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SchedulerTimezoneRequestSchema = z.object({
  timezone: IanaTimezoneSchema,
});

export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequestSchema>;
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequestSchema>;
export type AutomationTransferConfig = z.infer<typeof AutomationTransferConfigSchema>;
export type AutomationTransferPayload = z.infer<typeof AutomationTransferPayloadSchema>;
export type GenerateAutomationCodeRequest = z.infer<typeof GenerateAutomationCodeRequestSchema>;
export type PrepareGenerateAutomationCodeRequest = z.infer<typeof PrepareGenerateAutomationCodeRequestSchema>;
export type TestAutomationCodeRequest = z.infer<typeof TestAutomationCodeRequestSchema>;
export type RunAutomationRequest = z.infer<typeof RunAutomationRequestSchema>;
export type DeleteAutomationRunsRequest = z.infer<typeof DeleteAutomationRunsRequestSchema>;
export type AutomationRunsQuery = z.infer<typeof AutomationRunsQuerySchema>;
export type SchedulerTimezoneRequest = z.infer<typeof SchedulerTimezoneRequestSchema>;
