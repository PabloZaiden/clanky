import { ModelConfigSchema } from "@/contracts/schemas/model";
import type { ModelConfig } from "@/shared";
import { clientScopedStorageKey } from "@/platform/web/client-session";
import { createLogger } from "@pablozaiden/webapp/web";
import { getDemoStorage } from "@/client-sdk/demo/storage";

const log = createLogger("modelSelectionPreferences");

const CHAT_MODEL_STORAGE_KEY = "clanky.chatModelPreference";

export interface ModelPreferenceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ModelSelectionPreferenceDependencies {
  storage?: ModelPreferenceStorageLike;
}

function resolveStorage(
  storage?: ModelPreferenceStorageLike,
): ModelPreferenceStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return getDemoStorage() ?? window.localStorage;
  } catch (error) {
    log.warn("Model preference storage is unavailable", {
      error: String(error),
    });
    return null;
  }
}

function readStorageItem(
  storage: ModelPreferenceStorageLike,
  storageKey: string,
): string | null {
  try {
    return storage.getItem(clientScopedStorageKey(storageKey));
  } catch (error) {
    log.warn("Failed to read model preference", {
      storageKey,
      error: String(error),
    });
    return null;
  }
}

function removeStoredPreference(
  storage: ModelPreferenceStorageLike,
  storageKey: string,
  reason: Record<string, unknown>,
): void {
  try {
    storage.removeItem(clientScopedStorageKey(storageKey));
  } catch (error) {
    log.warn("Failed to clear invalid model preference", {
      storageKey,
      ...reason,
      cleanupError: String(error),
    });
  }
}

function readStoredModelPreference(
  storageKey: string,
  dependencies: ModelSelectionPreferenceDependencies = {},
): ModelConfig | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const raw = readStorageItem(storage, storageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const validation = ModelConfigSchema.safeParse(parsed);
    if (!validation.success) {
      log.warn("Removing invalid stored model preference", {
        storageKey,
        issues: validation.error.issues.map((issue) => issue.message),
      });
      removeStoredPreference(storage, storageKey, {
        issues: validation.error.issues.map((issue) => issue.message),
      });
      return null;
    }
    return validation.data;
  } catch (error) {
    log.warn("Removing invalid stored model preference", {
      storageKey,
      error: String(error),
    });
    removeStoredPreference(storage, storageKey, {
      error: String(error),
    });
    return null;
  }
}

function writeStoredPreference(
  storageKey: string,
  value: ModelConfig,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  try {
    storage.setItem(clientScopedStorageKey(storageKey), JSON.stringify(value));
  } catch (error) {
    log.warn("Failed to persist model preference", {
      storageKey,
      error: String(error),
    });
  }
}

export function getStoredChatModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): ModelConfig | null {
  return readStoredModelPreference(CHAT_MODEL_STORAGE_KEY, dependencies);
}

export function saveStoredChatModelPreference(
  model: ModelConfig,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  writeStoredPreference(CHAT_MODEL_STORAGE_KEY, model, dependencies);
}
