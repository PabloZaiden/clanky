/**
 * Safe, ephemeral context and client requests for the global voice assistant.
 */

import { z } from "zod";

export const LiveVoiceUiContextSchema = z.object({
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

export type LiveVoiceUiContext = z.infer<typeof LiveVoiceUiContextSchema>;

export interface LiveVoiceActivityEvent {
  type: "voice.activity";
  clientId: string;
  callId: string;
  processing: boolean;
}

export const VoiceConfirmationDescriptionSchema = z.string().trim().min(1).max(500);

export const VoiceConfirmationSchema = z.object({
  requestId: z.string().uuid(),
  description: VoiceConfirmationDescriptionSchema,
  expiresAt: z.number().int().positive(),
}).strict();

export type VoiceConfirmation = z.infer<typeof VoiceConfirmationSchema>;

export const VoiceClientActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get_context") }).strict(),
  z.object({ type: z.literal("confirm_operation"), confirmation: VoiceConfirmationSchema }).strict(),
  z.object({
    type: z.literal("request_ssh_credential"),
    requestId: z.string().uuid(),
    serverId: z.string().min(1).max(500),
    serverName: z.string().min(1).max(500),
    expiresAt: z.number().int().positive(),
  }).strict(),
]);
