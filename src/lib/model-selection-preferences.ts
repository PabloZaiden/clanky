import { CheapModelSelectionSchema, ModelConfigSchema } from "@/contracts/schemas/model";
import type { CheapModelSelection, ModelConfig } from "@/shared";
import { createClientLogger } from "./client-logger";

const log = createClientLogger("modelSelectionPreferences");

const TASK_MODEL_STORAGE_KEY = "clanky.taskModelPreference";
const TASK_CHEAP_MODEL_STORAGE_KEY = "clanky.taskCheapModelPreference";
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
    return window.localStorage;
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
    return storage.getItem(storageKey);
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
    storage.removeItem(storageKey);
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

function readStoredCheapModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): CheapModelSelection | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const raw = readStorageItem(storage, TASK_CHEAP_MODEL_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const validation = CheapModelSelectionSchema.safeParse(parsed);
    if (!validation.success) {
      log.warn("Removing invalid stored cheap-model preference", {
        storageKey: TASK_CHEAP_MODEL_STORAGE_KEY,
        issues: validation.error.issues.map((issue) => issue.message),
      });
      removeStoredPreference(storage, TASK_CHEAP_MODEL_STORAGE_KEY, {
        issues: validation.error.issues.map((issue) => issue.message),
      });
      return null;
    }
    return validation.data;
  } catch (error) {
    log.warn("Removing invalid stored cheap-model preference", {
      storageKey: TASK_CHEAP_MODEL_STORAGE_KEY,
      error: String(error),
    });
    removeStoredPreference(storage, TASK_CHEAP_MODEL_STORAGE_KEY, {
      error: String(error),
    });
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

export function getStoredTaskModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): ModelConfig | null {
  return readStoredModelPreference(TASK_MODEL_STORAGE_KEY, dependencies);
}

export function saveStoredTaskModelPreference(
  model: ModelConfig,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  writeStoredPreference(TASK_MODEL_STORAGE_KEY, model, dependencies);
}

export function getStoredTaskCheapModelPreference(
  dependencies: ModelSelectionPreferenceDependencies = {},
): CheapModelSelection | null {
  return readStoredCheapModelPreference(dependencies);
}

export function saveStoredTaskCheapModelPreference(
  selection: CheapModelSelection,
  dependencies: ModelSelectionPreferenceDependencies = {},
): void {
  writeStoredPreference(TASK_CHEAP_MODEL_STORAGE_KEY, selection, dependencies);
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
