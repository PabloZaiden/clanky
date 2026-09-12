/**
 * Persistence for the current user's provider-neutral voice configuration.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";
import {
  DEFAULT_VOICE_LANGUAGE_HINTS,
  type VoiceCapability,
  type VoiceLanguageHint,
  type VoiceSettingsUpdate,
} from "@/shared";

const log = createLogger("persistence:voice-settings");
const VOICE_SETTINGS_KEY = "voiceProviderSettings";
const PERSISTED_VERSION = 1;

export interface PersistedVoiceValidation {
  state: "unconfigured" | "unvalidated" | "valid" | "invalid";
  checkedAt: string | null;
  error: string | null;
}

export interface PersistedVoiceSettings {
  version: 1;
  baseUrl: string;
  apiKey: string | null;
  models: {
    transcription: string;
    speech: string;
    text: string;
  };
  languageHints: VoiceLanguageHint[];
  validation: Record<VoiceCapability, PersistedVoiceValidation>;
}

function defaultValidation(): Record<VoiceCapability, PersistedVoiceValidation> {
  return {
    transcription: { state: "unconfigured", checkedAt: null, error: null },
    speech: { state: "unconfigured", checkedAt: null, error: null },
    text: { state: "unconfigured", checkedAt: null, error: null },
  };
}

function getRawSettings(): string | null {
  const row = getDatabase()
    .query("SELECT value FROM preferences WHERE key = ? AND user_id = ?")
    .get(VOICE_SETTINGS_KEY, requirePersistenceUserId()) as { value: string } | null;
  return row?.value ?? null;
}

function parseSettings(raw: string): PersistedVoiceSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Persisted voice settings are not valid JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Persisted voice settings have an invalid shape.");
  }

  const record = parsed as Record<string, unknown>;
  const models = record["models"];
  const validation = record["validation"];
  const apiKey = record["apiKey"];
  const languageHints = record["languageHints"];
  if (
    record["version"] !== PERSISTED_VERSION
    || typeof record["baseUrl"] !== "string"
    || !models || typeof models !== "object"
    || typeof (models as Record<string, unknown>)["transcription"] !== "string"
    || typeof (models as Record<string, unknown>)["speech"] !== "string"
    || typeof (models as Record<string, unknown>)["text"] !== "string"
    || (languageHints !== undefined && !Array.isArray(languageHints))
    || !validation || typeof validation !== "object"
    || (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string")
  ) {
    throw new Error("Persisted voice settings have an invalid shape.");
  }

  const rawValidation = validation as Record<string, unknown>;
  const parsedValidation = defaultValidation();
  for (const capability of ["transcription", "speech", "text"] as const) {
    const item = rawValidation[capability];
    if (!item || typeof item !== "object") {
      throw new Error("Persisted voice settings have invalid validation metadata.");
    }
    const validationRecord = item as Record<string, unknown>;
    const state = validationRecord["state"];
    if (
      state !== "unconfigured"
      && state !== "unvalidated"
      && state !== "valid"
      && state !== "invalid"
    ) {
      throw new Error("Persisted voice settings have an invalid validation state.");
    }
    parsedValidation[capability] = {
      state,
      checkedAt: typeof validationRecord["checkedAt"] === "string"
        ? validationRecord["checkedAt"]
        : null,
      error: typeof validationRecord["error"] === "string"
        ? validationRecord["error"]
        : null,
    };
  }

  return {
    version: 1,
    baseUrl: record["baseUrl"],
    apiKey: typeof apiKey === "string" ? apiKey : null,
    models: {
      transcription: (models as Record<string, unknown>)["transcription"] as string,
      speech: (models as Record<string, unknown>)["speech"] as string,
      text: (models as Record<string, unknown>)["text"] as string,
    },
    languageHints: (
      Array.isArray(languageHints) ? languageHints : DEFAULT_VOICE_LANGUAGE_HINTS
    ).filter(
      (hint): hint is VoiceLanguageHint => hint === "es" || hint === "en",
    ),
    validation: parsedValidation,
  };
}

export async function getPersistedVoiceSettings(): Promise<PersistedVoiceSettings | null> {
  const raw = getRawSettings();
  if (!raw) {
    return null;
  }
  try {
    return parseSettings(raw);
  } catch (error) {
    log.error("Failed to load persisted voice settings", { error: String(error) });
    throw error;
  }
}

export async function getPersistedVoiceApiKey(
  settings: PersistedVoiceSettings,
): Promise<string | null> {
  return settings.apiKey;
}

export async function savePersistedVoiceSettings(
  settings: PersistedVoiceSettings,
): Promise<void> {
  const userId = requirePersistenceUserId();
  getDatabase()
    .query(`
      INSERT INTO preferences (key, user_id, value)
      VALUES (?, ?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value
    `)
    .run(VOICE_SETTINGS_KEY, userId, JSON.stringify(settings));
}

export async function updatePersistedVoiceSettings(
  update: VoiceSettingsUpdate,
  existing: PersistedVoiceSettings | null,
): Promise<PersistedVoiceSettings> {
  const existingApiKey = existing
    ? await getPersistedVoiceApiKey(existing)
    : null;
  const nextApiKey = update.clearApiKey
    ? null
    : update.apiKey !== undefined && update.apiKey.trim().length > 0
      ? update.apiKey.trim()
      : existingApiKey;
  const credentialChanged = nextApiKey !== existingApiKey;
  const identityChanged = !existing
    || existing.baseUrl !== update.baseUrl
    || existing.models.transcription !== update.models.transcription
    || existing.models.speech !== update.models.speech
    || existing.models.text !== update.models.text
    || credentialChanged;
  const validation = identityChanged ? defaultValidation() : existing.validation;

  const next: PersistedVoiceSettings = {
    version: 1,
    baseUrl: update.baseUrl,
    apiKey: nextApiKey,
    models: update.models,
    languageHints: update.languageHints,
    validation,
  };
  await savePersistedVoiceSettings(next);
  return next;
}

export function getDefaultVoiceValidation(): Record<VoiceCapability, PersistedVoiceValidation> {
  return defaultValidation();
}
