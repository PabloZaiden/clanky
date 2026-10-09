import { z } from "zod";
import {
  ControlUiActionOutcomeSchema,
  ControlUiActionSchema,
} from "@/shared/clanky-control";

export const RequestControlUiActionSchema = z.object({
  chatId: z.string().min(1).max(500),
  clientId: z.string().uuid(),
  turnId: z.string().uuid(),
  action: ControlUiActionSchema,
}).strict();

export const AcknowledgeControlUiActionSchema = z.object({
  clientId: z.string().uuid(),
  chatId: z.string().min(1).max(500),
  turnId: z.string().uuid(),
  outcome: ControlUiActionOutcomeSchema,
}).strict();

export type RequestControlUiAction = z.infer<typeof RequestControlUiActionSchema>;
export type AcknowledgeControlUiAction = z.infer<typeof AcknowledgeControlUiActionSchema>;
