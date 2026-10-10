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
import {
  piperTtsProvider,
  type PiperSpeechService,
} from "./piper-tts";
import { DomainError } from "../domain/domain-error";
import {
  getDefaultVoiceValidation,
  getDefaultLiveVoiceSettings,
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
import type { PiperSpeechStatus } from "./piper-assets";
import { decryptPersistedSecret } from "../persistence/encrypted-secret";
import {
  validateLiveVoiceConfiguration,
  type LiveVoiceCredentials,
} from "./live-voice-provider";

const log = createLogger("core:voice-manager");

function emptySettings(): PersistedVoiceSettings {
  return {
    version: 3,
    baseUrl: "",
    apiKeyCiphertext: null,
    models: {
      transcription: "",
      text: "",
    },
    languageHints: [...DEFAULT_VOICE_LANGUAGE_HINTS],
    validation: getDefaultVoiceValidation(),
    live: getDefaultLiveVoiceSettings(),
  };
}

function capabilityConfigured(
  settings: PersistedVoiceSettings,
  capability: Exclude<VoiceCapability, "live">,
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
  piper: PiperSpeechStatus,
): VoiceSettings {
  const liveApiKeyConfigured = settings.live.useVoiceProvider
    ? Boolean(apiKey)
    : Boolean(settings.live.apiKeyCiphertext);
  const liveConfigured = Boolean(
    (settings.live.useVoiceProvider ? settings.baseUrl : settings.live.baseUrl)
    && liveApiKeyConfigured
    && settings.live.model
    && settings.models.text,
  );
  return {
    baseUrl: settings.baseUrl,
    apiKeyConfigured: Boolean(apiKey),
    models: settings.models,
    languageHints: settings.languageHints,
    piper,
    live: {
      useVoiceProvider: settings.live.useVoiceProvider,
      baseUrl: settings.live.baseUrl,
      apiKeyConfigured: liveApiKeyConfigured,
      model: settings.live.model,
      configured: liveConfigured,
    },
    capabilities: {
      transcription: publicCapabilityStatus(
        settings.validation.transcription,
        capabilityConfigured(settings, "transcription", apiKey),
      ),
      text: publicCapabilityStatus(
        settings.validation.text,
        capabilityConfigured(settings, "text", apiKey),
      ),
      live: publicCapabilityStatus(settings.validation.live, liveConfigured),
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
  constructor(private readonly piper: PiperSpeechService = piperTtsProvider) {}

  async requireLiveCredentials(): Promise<LiveVoiceCredentials> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    const credentials = await this.resolveLiveCredentials(settings, apiKey);
    if (!credentials) {
      throw new DomainError("voice_capability_not_configured", "Configure Live voice and its shared text model first.");
    }
    return credentials;
  }

  async getSettings(): Promise<VoiceSettings> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    return buildPublicSettings(settings, apiKey, await this.piper.getStatus());
  }

  async updateSettings(update: VoiceSettingsUpdate): Promise<VoiceSettings> {
    const normalized: VoiceSettingsUpdate = {
      ...update,
      baseUrl: normalizeVoiceBaseUrl(update.baseUrl),
      apiKey: update.apiKey?.trim(),
      models: {
        transcription: update.models.transcription.trim(),
        text: update.models.text.trim(),
      },
      languageHints: Array.from(new Set(update.languageHints)),
      ...(update.live ? {
        live: {
          ...update.live,
          baseUrl: normalizeVoiceBaseUrl(update.live.baseUrl),
          model: update.live.model.trim(),
        },
      } : {}),
    };
    const next = await updatePersistedVoiceSettings(normalized);
    const apiKey = await getPersistedVoiceApiKey(next);
    return buildPublicSettings(next, apiKey, await this.piper.getStatus());
  }

  async validateCapability(
    capability: VoiceCapability,
    signal?: AbortSignal,
  ): Promise<VoiceSettings> {
    const settings = await getPersistedVoiceSettings() ?? emptySettings();
    const apiKey = await getPersistedVoiceApiKey(settings);
    let validationRequest: () => Promise<void>;
    if (capability === "live") {
      const credentials = await this.resolveLiveCredentials(settings, apiKey);
      if (!credentials) {
        throw new DomainError(
          "voice_capability_not_configured",
          "Configure the Live provider URL, API key, Live model, and shared text model before validating.",
        );
      }
      validationRequest = async () => {
        await validateLiveVoiceConfiguration(credentials, signal);
      };
    } else {
      if (!apiKey || !capabilityConfigured(settings, capability, apiKey)) {
        throw new DomainError(
          "voice_capability_not_configured",
          "Configure the provider URL, API key, and model before validating this capability.",
        );
      }
      const provider = new OpenAiCompatibleVoiceProvider({
        baseUrl: settings.baseUrl,
        apiKey,
      });
      validationRequest = capability === "transcription"
        ? async () => {
            await provider.validateTranscription(
              settings.models.transcription,
              settings.languageHints,
              signal,
            );
          }
        : async () => {
            await provider.completeText(
              settings.models.text,
              "Reply with exactly OK.",
              signal,
            );
          };
    }
    try {
      await validationRequest();
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
    return buildPublicSettings(persisted, apiKey, await this.piper.getStatus());
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
    try {
      return await provider.transcribe({
        audio,
        filename,
        mimeType,
        model: settings.models.transcription,
        languageHints: settings.languageHints,
        signal,
      });
    } catch (error) {
      if (!signal?.aborted) {
        const logContext: {
          operation: "transcription";
          errorCode: string;
          providerStatus?: number;
        } = {
          operation: "transcription",
          errorCode: isDomainError(error) ? error.code : "unexpected_error",
        };
        const providerStatus = isDomainError(error)
          ? error.details["status"]
          : undefined;
        if (typeof providerStatus === "number") {
          logContext.providerStatus = providerStatus;
        }

        if (isDomainError(error) && error.code === "voice_provider_rate_limited") {
          log.warn("Voice transcription provider request was rate limited", logContext);
        } else {
          log.error("Voice transcription provider request failed", logContext);
        }
      }
      throw error;
    }
  }

  async synthesizeSpeech(
    text: string,
    mode: VoiceSpeechMode,
    signal?: AbortSignal,
  ): Promise<{ audio: ArrayBuffer; contentType: "audio/wav" }> {
    const normalizedText = text.trim();
    if (!normalizedText || normalizedText.length > VOICE_MAX_TEXT_CHARS) {
      throw new DomainError(
        "voice_text_too_large",
        "The text for speech is empty or too long.",
      );
    }
    if (!(await this.piper.getStatus()).available) {
      throw new DomainError(
        "voice_piper_unsupported_platform",
        "Local Piper speech is not supported on this server platform.",
      );
    }

    let speechText = normalizedText;
    if (mode === "summary") {
      const textCapability = await this.requireConfiguredCapability("text");
      const provider = new OpenAiCompatibleVoiceProvider({
        baseUrl: textCapability.settings.baseUrl,
        apiKey: textCapability.apiKey,
      });
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

    return await this.piper.synthesizeSpeech(speechText, signal);
  }

  private async requireConfiguredCapability(
    capability: Exclude<VoiceCapability, "live">,
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

  private async resolveLiveCredentials(
    settings: PersistedVoiceSettings,
    voiceApiKey: string | null,
  ): Promise<LiveVoiceCredentials | null> {
    const live = settings.live;
    const apiKey = live.useVoiceProvider
      ? voiceApiKey
      : live.apiKeyCiphertext
        ? await decryptPersistedSecret(live.apiKeyCiphertext)
        : null;
    const baseUrl = live.useVoiceProvider ? settings.baseUrl : live.baseUrl;
    const textModel = settings.models.text;
    if (!apiKey || !baseUrl || !live.model || !textModel) {
      return null;
    }
    return { baseUrl, apiKey, model: live.model, textModel };
  }
}

export const voiceManager = new VoiceManager();
