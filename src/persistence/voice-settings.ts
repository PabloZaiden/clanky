/**
 * Persistence for the current user's provider-neutral voice configuration.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { getDatabase } from "./database";
import { requirePersistenceUserId } from "./ownership";
import {
  decryptPersistedSecret,
  encryptPersistedSecret,
} from "./encrypted-secret";
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
  apiKeyCiphertext: string | null;
  legacyApiKey?: string | null;
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

function validatePersistedBaseUrl(baseUrl: string): void {
  if (!baseUrl) {
    return;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("Persisted voice settings have an invalid provider URL.", { cause: error });
  }
  const queryKeys = Array.from(url.searchParams.keys());
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username
    || url.password
    || url.hash
    || queryKeys.some((key) => key.toLowerCase() !== "api-version")
    || queryKeys.filter((key) => key.toLowerCase() === "api-version").length > 1
  ) {
    throw new Error("Persisted voice settings have an unsafe provider URL.");
  }
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
  const baseUrl = record["baseUrl"];
  const models = record["models"];
  const validation = record["validation"];
  const apiKeyCiphertext = record["apiKeyCiphertext"];
  const legacyApiKey = record["apiKey"];
  const languageHints = record["languageHints"];
  if (
    record["version"] !== PERSISTED_VERSION
    || typeof baseUrl !== "string"
    || !models || typeof models !== "object"
    || typeof (models as Record<string, unknown>)["transcription"] !== "string"
    || typeof (models as Record<string, unknown>)["speech"] !== "string"
    || typeof (models as Record<string, unknown>)["text"] !== "string"
    || (languageHints !== undefined && !Array.isArray(languageHints))
    || !validation || typeof validation !== "object"
    || (
      apiKeyCiphertext !== undefined
      && apiKeyCiphertext !== null
      && typeof apiKeyCiphertext !== "string"
    )
    || (
      legacyApiKey !== undefined
      && legacyApiKey !== null
      && typeof legacyApiKey !== "string"
    )
  ) {
    throw new Error("Persisted voice settings have an invalid shape.");
  }
  validatePersistedBaseUrl(baseUrl);

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
    baseUrl,
    apiKeyCiphertext: typeof apiKeyCiphertext === "string"
      ? apiKeyCiphertext
      : null,
    legacyApiKey: typeof legacyApiKey === "string" ? legacyApiKey : null,
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
    return null;
  }
}

async function readPersistedVoiceApiKey(
  settings: PersistedVoiceSettings,
): Promise<string | null> {
  if (settings.legacyApiKey) {
    return settings.legacyApiKey;
  }
  if (!settings.apiKeyCiphertext) {
    return null;
  }
  try {
    return await decryptPersistedSecret(settings.apiKeyCiphertext);
  } catch (error) {
    log.error("Failed to decrypt persisted voice provider key", {
      error: String(error),
    });
    return null;
  }
}

function serializeSettings(settings: PersistedVoiceSettings): string {
  return JSON.stringify({
    version: settings.version,
    baseUrl: settings.baseUrl,
    apiKeyCiphertext: settings.apiKeyCiphertext,
    models: settings.models,
    languageHints: settings.languageHints,
    validation: settings.validation,
  });
}

async function writePersistedVoiceSettings(
  settings: PersistedVoiceSettings,
): Promise<void> {
  const userId = requirePersistenceUserId();
  getDatabase()
    .query(`
      INSERT INTO preferences (key, user_id, value)
      VALUES (?, ?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value
    `)
    .run(VOICE_SETTINGS_KEY, userId, serializeSettings(settings));
}

let writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function getPersistedVoiceApiKey(
  settings: PersistedVoiceSettings,
): Promise<string | null> {
  const apiKey = await readPersistedVoiceApiKey(settings);
  if (!settings.legacyApiKey || !apiKey) {
    return apiKey;
  }

  const migratedCiphertext = await encryptPersistedSecret(apiKey);
  await enqueueWrite(async () => {
    const current = await getPersistedVoiceSettings();
    if (!current?.legacyApiKey) {
      return;
    }
    await writePersistedVoiceSettings({
      ...current,
      apiKeyCiphertext: migratedCiphertext,
      legacyApiKey: null,
    });
  });
  settings.apiKeyCiphertext = migratedCiphertext;
  settings.legacyApiKey = null;
  return apiKey;
}

export async function updatePersistedVoiceSettings(
  update: VoiceSettingsUpdate,
): Promise<PersistedVoiceSettings> {
  return await enqueueWrite(async () => {
    const existing = await getPersistedVoiceSettings();
    const existingApiKey = existing
      ? await readPersistedVoiceApiKey(existing)
      : null;
    const nextApiKey = update.clearApiKey
      ? null
      : update.apiKey !== undefined && update.apiKey.trim().length > 0
        ? update.apiKey.trim()
        : existingApiKey;
    const apiKeyCiphertext = nextApiKey
      ? existing?.apiKeyCiphertext && existingApiKey === nextApiKey
        ? existing.apiKeyCiphertext
        : await encryptPersistedSecret(nextApiKey)
      : null;
    const baseUrlChanged = !existing || existing.baseUrl !== update.baseUrl;
    const apiKeyChanged = !existing
      || existingApiKey !== nextApiKey
      || existing.apiKeyCiphertext === null && apiKeyCiphertext !== null
      || existing.apiKeyCiphertext !== null && apiKeyCiphertext === null;
    const changedCapabilities = new Set<VoiceCapability>();
    if (baseUrlChanged || apiKeyChanged) {
      changedCapabilities.add("transcription");
      changedCapabilities.add("speech");
      changedCapabilities.add("text");
    }
    if (!existing || existing.models.transcription !== update.models.transcription) {
      changedCapabilities.add("transcription");
    }
    if (!existing || existing.models.speech !== update.models.speech) {
      changedCapabilities.add("speech");
    }
    if (!existing || existing.models.text !== update.models.text) {
      changedCapabilities.add("text");
    }
    if (
      !existing
      || existing.languageHints.join(",") !== update.languageHints.join(",")
    ) {
      changedCapabilities.add("transcription");
    }

    const validation = existing
      ? { ...existing.validation }
      : defaultValidation();
    for (const capability of ["transcription", "speech", "text"] as const) {
      const configured = Boolean(
        update.baseUrl
        && nextApiKey
        && update.models[capability],
      );
      if (changedCapabilities.has(capability) || !configured) {
        validation[capability] = configured
          ? { state: "unvalidated", checkedAt: null, error: null }
          : { state: "unconfigured", checkedAt: null, error: null };
      }
    }

    const next: PersistedVoiceSettings = {
      version: 1,
      baseUrl: update.baseUrl,
      apiKeyCiphertext,
      models: update.models,
      languageHints: update.languageHints,
      validation,
    };
    await writePersistedVoiceSettings(next);
    return next;
  });
}

export interface VoiceValidationIdentity {
  baseUrl: string;
  apiKeyCiphertext: string | null;
  model: string;
  languageHints: VoiceLanguageHint[] | null;
}

export function getVoiceValidationIdentity(
  settings: PersistedVoiceSettings,
  capability: VoiceCapability,
): VoiceValidationIdentity {
  return {
    baseUrl: settings.baseUrl,
    apiKeyCiphertext: settings.apiKeyCiphertext,
    model: settings.models[capability],
    languageHints: capability === "transcription"
      ? [...settings.languageHints]
      : null,
  };
}

function validationIdentityMatches(
  settings: PersistedVoiceSettings,
  capability: VoiceCapability,
  expected: VoiceValidationIdentity,
): boolean {
  const actual = getVoiceValidationIdentity(settings, capability);
  return actual.baseUrl === expected.baseUrl
    && actual.apiKeyCiphertext === expected.apiKeyCiphertext
    && actual.model === expected.model
    && JSON.stringify(actual.languageHints) === JSON.stringify(expected.languageHints);
}

export async function updatePersistedVoiceValidation(
  capability: VoiceCapability,
  expectedIdentity: VoiceValidationIdentity,
  validation: PersistedVoiceValidation,
): Promise<PersistedVoiceSettings | null> {
  return await enqueueWrite(async () => {
    const current = await getPersistedVoiceSettings();
    if (
      !current
      || !validationIdentityMatches(current, capability, expectedIdentity)
    ) {
      return null;
    }
    const apiKeyCiphertext = current.apiKeyCiphertext
      ?? (current.legacyApiKey
        ? await encryptPersistedSecret(current.legacyApiKey)
        : null);
    const next: PersistedVoiceSettings = {
      ...current,
      apiKeyCiphertext,
      legacyApiKey: null,
      validation: {
        ...current.validation,
        [capability]: validation,
      },
    };
    await writePersistedVoiceSettings(next);
    return next;
  });
}

export function getDefaultVoiceValidation(): Record<VoiceCapability, PersistedVoiceValidation> {
  return defaultValidation();
}
