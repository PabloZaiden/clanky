import { z } from "zod";
import { HarnessActivitySchema, HarnessConversationBindingSchema } from "./harness";

export const SubagentSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().optional(),
  workspaceId: z.string().nullable(),
  binding: HarnessConversationBindingSchema,
  activity: HarnessActivitySchema,
  coverage: z.enum(["partial", "complete"]),
  observation: z.enum(["connected", "disconnected", "unsupported", "error"]),
  error: z.string().optional(),
  unfinishedMessageIds: z.array(z.string().min(1)).max(1000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine((value) => Boolean(value.chatId), "A subagent requires a parent chat.");

export const SubagentListQuerySchema = z.object({ before: z.string().min(1).max(2048).optional() });
