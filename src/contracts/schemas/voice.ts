/**
 * Request schemas for the provider-neutral voice API.
 */

import { z } from "zod";
import {
  DEFAULT_VOICE_LANGUAGE_HINTS,
  VOICE_CAPABILITIES,
  VOICE_LANGUAGE_HINTS,
} from "@/shared";

const VoiceModelsSchema = z.object({
  transcription: z.string().trim().max(200, "transcription model is too long"),
  text: z.string().trim().max(200, "text model is too long"),
});

export const VoiceSettingsUpdateSchema = z.object({
  baseUrl: z.string().trim().max(2_000, "base URL is too long"),
  apiKey: z.string().trim().max(10_000, "API key is too long").optional(),
  clearApiKey: z.boolean().optional().default(false),
  models: VoiceModelsSchema,
  languageHints: z.array(z.enum(VOICE_LANGUAGE_HINTS)).max(2).default(
    [...DEFAULT_VOICE_LANGUAGE_HINTS],
  ),
  live: z.object({
    useVoiceProvider: z.boolean(),
    baseUrl: z.string().trim().max(2_000),
    apiKey: z.string().trim().max(10_000).optional(),
    clearApiKey: z.boolean().optional(),
    model: z.string().trim().max(200),
    textModel: z.string().trim().max(200),
  }).strict().optional(),
});

export const VoiceCapabilitySchema = z.enum(VOICE_CAPABILITIES);

export const VoiceValidationRequestSchema = z.object({
  capability: VoiceCapabilitySchema,
});

export const VoiceSpeechRequestSchema = z.object({
  text: z.string().trim().min(1, "text is required").max(30_000, "text is too long"),
  mode: z.enum(["full", "summary"]).default("full"),
});

export const LiveVoiceSessionRequestSchema = z.object({
  sdp: z.string().min(1).max(65_536),
  clientId: z.string().uuid(),
}).strict();

export type VoiceSettingsUpdateRequest = z.infer<typeof VoiceSettingsUpdateSchema>;
export type VoiceValidationRequest = z.infer<typeof VoiceValidationRequestSchema>;
export type VoiceSpeechRequest = z.infer<typeof VoiceSpeechRequestSchema>;
