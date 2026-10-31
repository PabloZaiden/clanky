/**
 * Ephemeral client context and human interactions for application control.
 */
import { z } from "zod";

export const ControlClientContextSchema = z.object({
  revision: z.number().int().nonnegative(),
  route: z.record(z.string().min(1).max(100), z.string().max(16_384))
    .refine((route) => Object.keys(route).length <= 24, "Too many route fields"),
  planningPreferences: z.object({
    autoAcceptPlan: z.boolean(),
    fullyAutonomous: z.boolean(),
  }).strict().optional(),
  modelPreferences: z.object({
    taskModelJson: z.string().max(4_000).nullable(),
    cheapModelJson: z.string().max(4_000).nullable(),
  }).strict().optional(),
}).strict();
export type ControlClientContext = z.infer<typeof ControlClientContextSchema>;

export const ControlConfirmationDescriptionSchema = z.string().trim().min(1).max(500);
export const ControlConfirmationSchema = z.object({
  requestId: z.string().uuid(),
  description: ControlConfirmationDescriptionSchema,
  expiresAt: z.number().int().positive(),
}).strict();
export type ControlConfirmation = z.infer<typeof ControlConfirmationSchema>;

export const ControlClientActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get_context") }).strict(),
  z.object({ type: z.literal("confirm_operation"), confirmation: ControlConfirmationSchema }).strict(),
]);
