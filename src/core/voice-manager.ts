/**
 * Orchestration boundary for per-user voice settings and provider calls.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import {
  DEFAULT_VOICE_LANGUAGE_HINTS,
} from "@/shared";
import type {
  VoiceCapability,
  VoiceCapabilityStatus,
  VoiceSettings,
  VoiceSettingsUpdate,
  VoiceSpeechMode,
} from "@/shared";
import { DomainError } from "../domain/domain-error";
import {
  getDefaultVoiceValidation,
  getVoiceValidationIdentity,
  getPersistedVoiceApiKey,
  getPersistedVoiceSettings,
  updatePersistedVoiceSettings,
  updatePersistedVoiceValidation,
  type PersistedVoiceSettings,
  type PersistedVoiceValidation,
} from "../persistence/voice-settings";
import { isDomainError } from "../domain/domain-error";
import {
  normalizeVoiceBaseUrl,
  OpenAiCompatibleVoiceProvider,
  VOICE_MAX_AUDIO_BYTES,
  VOICE_MAX_SUMMARY_CHARS,
  VOICE_MAX_TEXT_CHARS,
} from "./voice-provider";

const log = createLogger("core:voice-manager");
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-transcribe";
const DEFAULT_SPEECH_MODEL = "tts";
const DEFAULT_TEXT_MODEL = "gpt-5.6-luna";

function emptySettings(): PersistedVoiceSettings {
  return {
    version: 1,
    baseUrl: "",
    apiKeyCiphertext: null,
    models: {
      transcription: DEFAULT_TRANSCRIPTION_MODEL,
      speech: DEFAULT_SPEECH_MODEL,
      text: DEFAULT_TEXT_MODEL,
    },
    languageHints: [...DEFAULT_VOICE_LANGUAGE_HINTS],
    validation: getDefaultVoiceValidation(),
  };
}

function capabilityConfigured(
  settings: PersistedVoiceSettings,
  capability: VoiceCapability,
  apiKey: string | null,
): boolean {
  return Boolean(
    settings.baseUrl
    && apiKey
    && settings.models[capability],
  );
}

function publicCapabilityStatus(
  validation: PersistedVoiceValidation,
  configured: boolean,
): VoiceCapabilityStatus {
  const state = configured
    ? validation.state === "unconfigured" ? "unvalidated" : validation.state
    : "unconfigured";
  return {
    configured,
    validated: configured && state === "valid",
    state,
    checkedAt: configured ? validation.checkedAt : null,
    error: configured ? validation.error : null,
  };
}

function buildPublicSettings(
  settings: PersistedVoiceSettings,
  apiKey: string | null,
): VoiceSettings {
  return {
    baseUrl: settings.baseUrl,
    apiKeyConfigured: Boolean(apiKey),
    models: settings.models,
    languageHints: settings.languageHints,
    capabilities: {
      transcription: publicCapabilityStatus(
        settings.validation.transcription,
        capabilityConfigured(settings, "transcription", apiKey),
      ),
      speech: publicCapabilityStatus(
        settings.validation.speech,
        capabilityConfigured(settings, "speech", apiKey),
      ),
      text: publicCapabilityStatus(
        settings.validation.text,
        capabilityConfigured(settings, "text", apiKey),
      ),
    },
  };
}

function markValidation(
  settings: PersistedVoiceSettings,
  capability: VoiceCapability,
  state: PersistedVoiceValidation["state"],
  error: string | null,
): PersistedVoiceSettings {
  return {
    ...settings,
    validation: {
      ...settings.validation,
      [capability]: {
        state,
        checkedAt: new Date().toISOString(),
        error,
      },
    },
  };
}

function shouldPersistInvalidValidation(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (!isDomainError(error)) {
    return true;
  }
  return ![
    "voice_provider_rate_limited",
    "voice_provider_timeout",
    "voice_provider_unreachable",
  ].includes(error.code);
}

export class VoiceManager {
  async getSettings(): Promise<VoiceSettings> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    return buildPublicSettings(settings, apiKey);
  }

  async updateSettings(update: VoiceSettingsUpdate): Promise<VoiceSettings> {
    const normalized: VoiceSettingsUpdate = {
      ...update,
      baseUrl: normalizeVoiceBaseUrl(update.baseUrl),
      apiKey: update.apiKey?.trim(),
      models: {
        transcription: update.models.transcription.trim(),
        speech: update.models.speech.trim(),
        text: update.models.text.trim(),
      },
      languageHints: Array.from(new Set(update.languageHints)),
    };
    const next = await updatePersistedVoiceSettings(normalized);
    const apiKey = await getPersistedVoiceApiKey(next);
    return buildPublicSettings(next, apiKey);
  }

  async validateCapability(
    capability: VoiceCapability,
    signal?: AbortSignal,
  ): Promise<VoiceSettings> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    if (!capabilityConfigured(settings, capability, apiKey)) {
      throw new DomainError(
        "voice_capability_not_configured",
        "Configure the provider URL, API key, and model before validating this capability.",
      );
    }

    const provider = new OpenAiCompatibleVoiceProvider({
      baseUrl: settings.baseUrl,
      apiKey: apiKey as string,
    });
    try {
      if (capability === "transcription") {
        await provider.validateTranscription(
          settings.models.transcription,
          settings.languageHints,
          signal,
        );
      } else if (capability === "speech") {
        await provider.synthesizeSpeech({
          text: "OK",
          model: settings.models.speech,
          voice: "alloy",
          signal,
        });
      } else {
        await provider.completeText(
          settings.models.text,
          "Reply with exactly OK.",
          signal,
        );
      }
    } catch (error) {
      if (shouldPersistInvalidValidation(error, signal)) {
        const failed = markValidation(
          settings,
          capability,
          "invalid",
          "The provider validation request failed.",
        );
        const persisted = await updatePersistedVoiceValidation(
          capability,
          getVoiceValidationIdentity(settings, capability),
          failed.validation[capability],
        );
        if (!persisted) {
          throw new DomainError(
            "voice_validation_stale",
            "The voice settings changed while validation was running.",
            { cause: error },
          );
        }
      }
      log.warn("Voice provider capability validation failed", {
        capability,
        error: String(error),
      });
      throw error;
    }

    const validated = markValidation(settings, capability, "valid", null);
    const persisted = await updatePersistedVoiceValidation(
      capability,
      getVoiceValidationIdentity(settings, capability),
      validated.validation[capability],
    );
    if (!persisted) {
      throw new DomainError(
        "voice_validation_stale",
        "The voice settings changed while validation was running.",
      );
    }
    return buildPublicSettings(persisted, apiKey);
  }

  async transcribe(
    audio: Blob,
    filename: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (audio.size <= 0 || audio.size > VOICE_MAX_AUDIO_BYTES) {
      throw new DomainError(
        "voice_audio_too_large",
        "The recording is empty or exceeds the 20 MB limit.",
      );
    }
    const { settings, apiKey } = await this.requireConfiguredCapability("transcription");
    const provider = new OpenAiCompatibleVoiceProvider({
      baseUrl: settings.baseUrl,
      apiKey,
    });
    return await provider.transcribe({
      audio,
      filename,
      mimeType,
      model: settings.models.transcription,
      languageHints: settings.languageHints,
      signal,
    });
  }

  async synthesizeSpeech(
    text: string,
    mode: VoiceSpeechMode,
    voice: string,
    signal?: AbortSignal,
  ): Promise<{ audio: ArrayBuffer; contentType: string }> {
    const normalizedText = text.trim();
    if (!normalizedText || normalizedText.length > VOICE_MAX_TEXT_CHARS) {
      throw new DomainError(
        "voice_text_too_large",
        "The text for speech is empty or too long.",
      );
    }

    const { settings, apiKey } = await this.requireConfiguredCapability("speech");
    const provider = new OpenAiCompatibleVoiceProvider({
      baseUrl: settings.baseUrl,
      apiKey,
    });
    let speechText = normalizedText;
    if (mode === "summary") {
      const textCapability = await this.requireConfiguredCapability("text");
      speechText = await provider.completeText(
        textCapability.settings.models.text,
        [
          "Summarize the following assistant response for spoken playback.",
          "Keep the important decisions, results, errors, and next actions.",
          "Use the same language mix as the input when useful.",
          "Return only the concise summary, without headings or preamble.",
          normalizedText,
        ].join("\n\n"),
        signal,
      );
      speechText = speechText.slice(0, VOICE_MAX_SUMMARY_CHARS).trim();
    }

    return await provider.synthesizeSpeech({
      text: speechText,
      model: settings.models.speech,
      voice: voice.trim() || "alloy",
      signal,
    });
  }

  private async requireConfiguredCapability(
    capability: VoiceCapability,
  ): Promise<{ settings: PersistedVoiceSettings; apiKey: string }> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    const status = settings.validation[capability];
    if (!apiKey || !settings.baseUrl || !settings.models[capability] || status.state !== "valid") {
      throw new DomainError(
        "voice_capability_unavailable",
        "This voice capability is not configured and validated.",
        { details: { capability } },
      );
    }
    return { settings, apiKey };
  }
}

export const voiceManager = new VoiceManager();
