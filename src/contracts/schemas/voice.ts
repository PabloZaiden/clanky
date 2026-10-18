/**
 * Request schemas for the provider-neutral voice API.
 */

import { z } from "zod";
import { LiveVoiceUiContextSchema } from "@/shared/live-voice";
import {
  DEFAULT_VOICE_LANGUAGE_HINTS,
  LIVE_VOICE_MAX_PERSONAL_INSTRUCTIONS_CHARS,
  VOICE_CAPABILITIES,
  VOICE_LANGUAGE_HINTS,
  VOICE_MAX_TEXT_CHARS,
  VOICE_TRANSLATION_LANGUAGES,
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
    personalInstructions: z.string().max(
      LIVE_VOICE_MAX_PERSONAL_INSTRUCTIONS_CHARS,
      "Personal instructions must be at most 4,000 characters",
    ).optional(),
  }).strict().optional(),
});

export const VoiceCapabilitySchema = z.enum(VOICE_CAPABILITIES);

export const VoiceTranslationRequestSchema = z.object({
  text: z.string().trim().min(1, "Text is required").max(VOICE_MAX_TEXT_CHARS, "Text is too long"),
  targetLanguage: z.enum(VOICE_TRANSLATION_LANGUAGES),
}).strict();

export const VoiceTranslationResponseSchema = z.object({
  translatedText: z.string().min(1, "Translated text is required"),
}).strict();

export const VoiceValidationRequestSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("transcription") }),
  z.object({ capability: z.literal("text") }),
  z.object({
    capability: z.literal("live"),
    sdp: z.string().min(1).max(65_536),
  }),
]);

export const LiveVoiceSessionRequestSchema = z.object({
  sdp: z.string().min(1).max(65_536),
  clientId: z.string().uuid(),
  context: LiveVoiceUiContextSchema,
}).strict();

export const LiveVoiceHeartbeatSchema = z.object({
  clientId: z.string().uuid(),
  context: LiveVoiceUiContextSchema,
}).strict();
export const LiveVoiceCloseSchema = z.object({ clientId: z.string().uuid() }).strict();
export const LiveVoiceConfirmationResponseSchema = z.object({
  clientId: z.string().uuid(),
  approved: z.boolean(),
}).strict();
export const LiveVoiceCredentialResponseSchema = z.object({
  clientId: z.string().uuid(),
  credentialToken: z.string().uuid().nullable(),
}).strict();

export const LiveVoiceAvailabilityResponseSchema = z.object({
  supported: z.boolean(),
}).strict();

export type LiveVoiceAvailabilityResponse = z.infer<typeof LiveVoiceAvailabilityResponseSchema>;

export type VoiceSettingsUpdateRequest = z.infer<typeof VoiceSettingsUpdateSchema>;
export type VoiceTranslationRequest = z.infer<typeof VoiceTranslationRequestSchema>;
export type VoiceTranslationResponse = z.infer<typeof VoiceTranslationResponseSchema>;
export type VoiceValidationRequest = z.infer<typeof VoiceValidationRequestSchema>;
