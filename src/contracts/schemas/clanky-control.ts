import { z } from "zod";
import {
  ControlUiActionOutcomeSchema,
  ControlNavigationActionSchema,
  ControlUiSourceSchema,
} from "@/shared/clanky-control";

export const RequestControlUiActionSchema = z.object({
  chatId: z.string().min(1).max(500),
  clientId: z.string().uuid(),
  turnId: z.string().uuid(),
  action: z.union([
    ControlNavigationActionSchema.options[0],
    ControlNavigationActionSchema.options[1],
    ControlNavigationActionSchema.options[2],
  ]),
}).strict();

export const AcknowledgeControlUiActionSchema = z.object({
  clientId: z.string().uuid(),
  source: ControlUiSourceSchema,
  outcome: ControlUiActionOutcomeSchema,
}).strict();

export type RequestControlUiAction = z.infer<typeof RequestControlUiActionSchema>;
export type AcknowledgeControlUiAction = z.infer<typeof AcknowledgeControlUiActionSchema>;
