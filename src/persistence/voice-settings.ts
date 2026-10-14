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
  VOICE_CAPABILITIES,
  type VoiceCapability,
  type VoiceLanguageHint,
  type VoiceSettingsUpdate,
} from "@/shared";

const log = createLogger("persistence:voice-settings");
const VOICE_SETTINGS_KEY = "voiceProviderSettings";
const PERSISTED_VERSION = 3;

export interface PersistedVoiceValidation {
  state: "unconfigured" | "unvalidated" | "valid" | "invalid";
  checkedAt: string | null;
  error: string | null;
}

export interface PersistedVoiceSettings {
  version: 3;
  baseUrl: string;
  apiKeyCiphertext: string | null;
  models: {
    transcription: string;
    text: string;
  };
  languageHints: VoiceLanguageHint[];
  validation: Record<VoiceCapability, PersistedVoiceValidation>;
  live: {
    useVoiceProvider: boolean;
    baseUrl: string;
    apiKeyCiphertext: string | null;
    model: string;
  };
}

export function getDefaultLiveVoiceSettings(): PersistedVoiceSettings["live"] {
  return { useVoiceProvider: true, baseUrl: "", apiKeyCiphertext: null, model: "" };
}

function defaultValidation(): Record<VoiceCapability, PersistedVoiceValidation> {
  return Object.fromEntries(
    VOICE_CAPABILITIES.map((capability) => [
      capability,
      { state: "unconfigured", checkedAt: null, error: null },
    ]),
  ) as Record<VoiceCapability, PersistedVoiceValidation>;
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
  const version = record["version"];
  const baseUrl = record["baseUrl"];
  const models = record["models"];
  const validation = record["validation"];
  const apiKeyCiphertext = record["apiKeyCiphertext"];
  const languageHints = record["languageHints"];
  if (
    (version !== 1 && version !== 2 && version !== PERSISTED_VERSION)
    || typeof baseUrl !== "string"
    || !models || typeof models !== "object"
    || typeof (models as Record<string, unknown>)["transcription"] !== "string"
    || typeof (models as Record<string, unknown>)["text"] !== "string"
    || version === 1
      && typeof (models as Record<string, unknown>)["speech"] !== "string"
    || (languageHints !== undefined && !Array.isArray(languageHints))
    || !validation || typeof validation !== "object"
    || (
      apiKeyCiphertext !== null
      && typeof apiKeyCiphertext !== "string"
    )
  ) {
    throw new Error("Persisted voice settings have an invalid shape.");
  }
  validatePersistedBaseUrl(baseUrl);
  const live = parseLiveSettings(record["live"]);

  const rawValidation = validation as Record<string, unknown>;
  const parsedValidation = defaultValidation();
  for (const capability of VOICE_CAPABILITIES) {
    const item = rawValidation[capability];
    if (!item || typeof item !== "object") {
      if ((version === 1 || version === 2) && capability === "live") {
        continue;
      }
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
    version: PERSISTED_VERSION,
    baseUrl,
    apiKeyCiphertext: typeof apiKeyCiphertext === "string"
      ? apiKeyCiphertext
      : null,
    models: {
      transcription: (models as Record<string, unknown>)["transcription"] as string,
      text: (models as Record<string, unknown>)["text"] as string,
    },
    languageHints: (
      Array.isArray(languageHints) ? languageHints : DEFAULT_VOICE_LANGUAGE_HINTS
    ).filter(
      (hint): hint is VoiceLanguageHint => hint === "es" || hint === "en",
    ),
    validation: parsedValidation,
    live,
  };
}

function parseLiveSettings(value: unknown): PersistedVoiceSettings["live"] {
  if (value === undefined) return getDefaultLiveVoiceSettings();
  if (!value || typeof value !== "object") throw new Error("Persisted Live voice settings are invalid.");
  const record = value as Record<string, unknown>;
  const { useVoiceProvider, baseUrl, apiKeyCiphertext, model } = record;
  if (typeof useVoiceProvider !== "boolean" || typeof baseUrl !== "string" || typeof model !== "string"
    || (apiKeyCiphertext !== null && typeof apiKeyCiphertext !== "string")) {
    throw new Error("Persisted Live voice settings are invalid.");
  }
  validatePersistedBaseUrl(baseUrl);
  return { useVoiceProvider, baseUrl, apiKeyCiphertext, model };
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
    live: settings.live,
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
  return await readPersistedVoiceApiKey(settings);
}

export async function updatePersistedVoiceSettings(
  update: VoiceSettingsUpdate,
): Promise<PersistedVoiceSettings> {
  return await enqueueWrite(async () => {
    const existing = await getPersistedVoiceSettings();
    const previousLive = existing?.live ?? getDefaultLiveVoiceSettings();
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
    let live = previousLive;
    if (update.live) {
      const currentKey = live.apiKeyCiphertext
        ? await decryptPersistedSecret(live.apiKeyCiphertext)
        : null;
      const nextKey = update.live.clearApiKey
        ? null
        : update.live.apiKey?.trim() || currentKey;
      live = {
        useVoiceProvider: update.live.useVoiceProvider,
        baseUrl: update.live.baseUrl,
        model: update.live.model,
        apiKeyCiphertext: nextKey
          ? nextKey === currentKey
            ? live.apiKeyCiphertext
            : await encryptPersistedSecret(nextKey)
          : null,
      };
    }

    const baseUrlChanged = !existing || existing.baseUrl !== update.baseUrl;
    const apiKeyChanged = !existing
      || existingApiKey !== nextApiKey
      || existing.apiKeyCiphertext === null && apiKeyCiphertext !== null
      || existing.apiKeyCiphertext !== null && apiKeyCiphertext === null;
    const textModelChanged = !existing || existing.models.text !== update.models.text;
    const changedCapabilities = new Set<VoiceCapability>();
    if (baseUrlChanged || apiKeyChanged) {
      changedCapabilities.add("transcription");
      changedCapabilities.add("text");
      if (previousLive.useVoiceProvider || live.useVoiceProvider) {
        changedCapabilities.add("live");
      }
    }
    if (!existing || existing.models.transcription !== update.models.transcription) {
      changedCapabilities.add("transcription");
    }
    if (textModelChanged) {
      changedCapabilities.add("text");
      changedCapabilities.add("live");
    }
    if (
      !existing
      || existing.languageHints.join(",") !== update.languageHints.join(",")
    ) {
      changedCapabilities.add("transcription");
    }
    if (
      !existing
      || previousLive.useVoiceProvider !== live.useVoiceProvider
      || previousLive.baseUrl !== live.baseUrl
      || previousLive.apiKeyCiphertext !== live.apiKeyCiphertext
      || previousLive.model !== live.model
    ) {
      changedCapabilities.add("live");
    }

    const validation = existing
      ? { ...existing.validation }
      : defaultValidation();
    for (const capability of VOICE_CAPABILITIES) {
      const configured = capability === "live"
        ? Boolean(
            (live.useVoiceProvider ? update.baseUrl : live.baseUrl)
            && (live.useVoiceProvider ? nextApiKey : live.apiKeyCiphertext)
            && live.model
            && update.models.text,
          )
        : Boolean(update.baseUrl && nextApiKey && update.models[capability]);
      if (changedCapabilities.has(capability) || !configured) {
        validation[capability] = configured
          ? { state: "unvalidated", checkedAt: null, error: null }
          : { state: "unconfigured", checkedAt: null, error: null };
      }
    }

    const next: PersistedVoiceSettings = {
      version: PERSISTED_VERSION,
      baseUrl: update.baseUrl,
      apiKeyCiphertext,
      models: update.models,
      languageHints: update.languageHints,
      validation,
      live,
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
  delegatedModel: string | null;
  useVoiceProvider: boolean | null;
}

export function getVoiceValidationIdentity(
  settings: PersistedVoiceSettings,
  capability: VoiceCapability,
): VoiceValidationIdentity {
  const isLive = capability === "live";
  const usesVoiceProvider = isLive && settings.live.useVoiceProvider;
  return {
    baseUrl: isLive && !usesVoiceProvider
      ? settings.live.baseUrl
      : settings.baseUrl,
    apiKeyCiphertext: isLive && !usesVoiceProvider
      ? settings.live.apiKeyCiphertext
      : settings.apiKeyCiphertext,
    model: isLive ? settings.live.model : settings.models[capability],
    languageHints: capability === "transcription"
      ? [...settings.languageHints]
      : null,
    delegatedModel: isLive ? settings.models.text : null,
    useVoiceProvider: isLive ? settings.live.useVoiceProvider : null,
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
    && JSON.stringify(actual.languageHints) === JSON.stringify(expected.languageHints)
    && actual.delegatedModel === expected.delegatedModel
    && actual.useVoiceProvider === expected.useVoiceProvider;
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
    const next: PersistedVoiceSettings = {
      ...current,
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
