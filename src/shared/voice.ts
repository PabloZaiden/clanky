/**
 * Browser-safe types for the optional per-user voice features.
 */

import type { Chat } from "./chat";

export function supportsLiveVoice(chat: Pick<Chat, "config">): boolean {
  return chat.config.model.providerID === "codex" || chat.config.model.providerID === "copilot";
}

export const VOICE_CAPABILITIES = ["transcription", "text"] as const;
export type VoiceCapability = (typeof VOICE_CAPABILITIES)[number];

export const VOICE_LANGUAGE_HINTS = ["es", "en"] as const;
export type VoiceLanguageHint = (typeof VOICE_LANGUAGE_HINTS)[number];
export const DEFAULT_VOICE_LANGUAGE_HINTS: VoiceLanguageHint[] = [
  ...VOICE_LANGUAGE_HINTS,
];

const VOICE_AUDIO_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export function getVoiceAudioExtension(mimeType: string): string {
  const normalizedMimeType = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return VOICE_AUDIO_EXTENSION_BY_MIME_TYPE[normalizedMimeType] ?? "webm";
}

export type VoiceValidationState = "unconfigured" | "unvalidated" | "valid" | "invalid";

export interface VoiceCapabilityStatus {
  configured: boolean;
  validated: boolean;
  state: VoiceValidationState;
  checkedAt: string | null;
  error: string | null;
}

export interface VoiceSettings {
  baseUrl: string;
  apiKeyConfigured: boolean;
  models: {
    transcription: string;
    text: string;
  };
  languageHints: VoiceLanguageHint[];
  capabilities: Record<VoiceCapability, VoiceCapabilityStatus>;
  piper: {
    available: boolean;
  };
  live: LiveVoiceSettings;
}

export interface LiveVoiceSettings {
  useVoiceProvider: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  model: string;
  textModel: string;
  configured: boolean;
}

export interface LiveVoiceSettingsUpdate {
  useVoiceProvider: boolean;
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model: string;
  textModel: string;
}

export interface LiveVoiceCallState {
  id: string;
  status: "connecting" | "active" | "closing" | "closed" | "failed";
  error: string | null;
  summarySaved: boolean;
}

export interface LiveVoiceSessionResponse {
  call: LiveVoiceCallState;
  sdp: string;
}

export interface VoiceSettingsUpdate {
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  models: VoiceSettings["models"];
  languageHints: VoiceLanguageHint[];
  live?: LiveVoiceSettingsUpdate;
}

export type VoiceSpeechMode = "full" | "summary";
