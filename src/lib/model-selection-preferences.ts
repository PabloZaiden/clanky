import { CheapModelSelectionSchema, ModelConfigSchema } from "../types/schemas/model";
import type { CheapModelSelection, ModelConfig } from "../types";
import { createLogger } from "./logger";

const log = createLogger("modelSelectionPreferences");

const LOOP_MODEL_STORAGE_KEY = "ralpher.loopModelPreference";
const LOOP_CHEAP_MODEL_STORAGE_KEY = "ralpher.loopCheapModelPreference";
const CHAT_MODEL_STORAGE_KEY = "ralpher.chatModelPreference";

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
    return window.localStorage;
  } catch (error) {
    log.warn("Model preference storage is unavailable", {
      error: String(error),
    });
    return null;
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

  const raw = storage.getItem(storageKey);
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
      storage.removeItem(storageKey);
      return null;
    }
    return validation.data;
  } catch (error) {
    log.warn("Removing invalid stored model preference", {
      storageKey,
      error: String(error),
    });
    storage.removeItem(storageKey);
    return null;
  }
}

function readStoredCheapModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): CheapModelSelection | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(LOOP_CHEAP_MODEL_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const validation = CheapModelSelectionSchema.safeParse(parsed);
    if (!validation.success) {
      log.warn("Removing invalid stored cheap-model preference", {
        storageKey: LOOP_CHEAP_MODEL_STORAGE_KEY,
        issues: validation.error.issues.map((issue) => issue.message),
      });
      storage.removeItem(LOOP_CHEAP_MODEL_STORAGE_KEY);
      return null;
    }
    return validation.data;
  } catch (error) {
    log.warn("Removing invalid stored cheap-model preference", {
      storageKey: LOOP_CHEAP_MODEL_STORAGE_KEY,
      error: String(error),
    });
    storage.removeItem(LOOP_CHEAP_MODEL_STORAGE_KEY);
    return null;
  }
}

function writeStoredPreference(
  storageKey: string,
  value: CheapModelSelection | ModelConfig,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  try {
    storage.setItem(storageKey, JSON.stringify(value));
  } catch (error) {
    log.warn("Failed to persist model preference", {
      storageKey,
      error: String(error),
    });
  }
}

export function getStoredLoopModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): ModelConfig | null {
  return readStoredModelPreference(LOOP_MODEL_STORAGE_KEY, dependencies);
}

export function saveStoredLoopModelPreference(
  model: ModelConfig,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  writeStoredPreference(LOOP_MODEL_STORAGE_KEY, model, dependencies);
}

export function getStoredLoopCheapModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): CheapModelSelection | null {
  return readStoredCheapModelPreference(dependencies);
}

export function saveStoredLoopCheapModelPreference(
  selection: CheapModelSelection,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  writeStoredPreference(LOOP_CHEAP_MODEL_STORAGE_KEY, selection, dependencies);
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
