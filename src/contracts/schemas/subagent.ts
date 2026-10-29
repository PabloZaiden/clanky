import { z } from "zod";
import { HarnessActivitySchema, HarnessConversationBindingSchema } from "./harness";

export const SubagentSchema = z.object({
  id: z.string().uuid(),
  chatId: z.string().optional(),
  taskId: z.string().optional(),
  workspaceId: z.string().nullable(),
  binding: HarnessConversationBindingSchema,
  activity: HarnessActivitySchema,
  coverage: z.enum(["partial", "complete"]),
  observation: z.enum(["connected", "disconnected", "unsupported", "error"]),
  error: z.string().optional(),
  unfinishedMessageIds: z.array(z.string().min(1)).max(1000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine((value) => Boolean(value.chatId) !== Boolean(value.taskId), "A subagent requires exactly one parent.");

export const SubagentListQuerySchema = z.object({ before: z.string().min(1).max(2048).optional() });
