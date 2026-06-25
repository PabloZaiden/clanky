/**
 * Zod schemas for scheduled agents.
 *
 * Agents execute recurring headless chat-style prompts for a workspace.
 */

import { z } from "zod";
import { isValidIanaTimeZone } from "@/shared";
import { ModelConfigSchema } from "./model";
import { TaskNameSchema, MessageImageAttachmentsSchema } from "./task";

export const AgentScheduleIntervalUnitSchema = z.enum(["minutes", "hours", "days"]);

const IanaTimezoneSchema = z.string().trim().min(1, "timezone is required").refine(
  isValidIanaTimeZone,
  { message: "timezone must be a valid IANA timezone" },
);

export const AgentScheduleIntervalSchema = z.object({
  value: z.number().int().positive("interval value must be greater than 0"),
  unit: AgentScheduleIntervalUnitSchema,
});

export const AgentScheduleSchema = z.object({
  startAtLocal: z.string().trim().min(1, "startAtLocal is required"),
  timezone: IanaTimezoneSchema,
  interval: AgentScheduleIntervalSchema,
  nextRunAt: z.string().datetime().optional(),
});

export const CreateAgentRequestSchema = z.object({
  name: TaskNameSchema,
  workspaceId: z.string().min(1, "workspaceId is required"),
  prompt: z.string().trim().min(1, "prompt is required"),
  model: ModelConfigSchema,
  baseBranch: z.string().trim().min(1, "baseBranch must be non-empty when provided").optional(),
  useWorktree: z.boolean({ error: "useWorktree is required and must be a boolean (true or false)" }),
  schedule: AgentScheduleSchema,
  enabled: z.boolean().default(true),
});

export const UpdateAgentRequestSchema = z.object({
  name: TaskNameSchema.optional(),
  prompt: z.string().trim().min(1, "prompt cannot be empty").optional(),
  model: ModelConfigSchema.optional(),
  baseBranch: z.string().trim().min(1, "baseBranch must be non-empty when provided").nullable().optional(),
  useWorktree: z.boolean().optional(),
  schedule: AgentScheduleSchema.optional(),
  enabled: z.boolean().optional(),
});

export const RunAgentRequestSchema = z.object({
  attachments: MessageImageAttachmentsSchema.default([]),
}).default({ attachments: [] });

export const DeleteAgentRunsRequestSchema = z.object({
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

export const AgentRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SchedulerTimezoneRequestSchema = z.object({
  timezone: IanaTimezoneSchema,
});

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type RunAgentRequest = z.infer<typeof RunAgentRequestSchema>;
export type DeleteAgentRunsRequest = z.infer<typeof DeleteAgentRunsRequestSchema>;
export type AgentRunsQuery = z.infer<typeof AgentRunsQuerySchema>;
export type SchedulerTimezoneRequest = z.infer<typeof SchedulerTimezoneRequestSchema>;
