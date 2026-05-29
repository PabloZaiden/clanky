import { createLogger } from "./logger";

const log = createLogger("newTaskPlanningPreferences");

const NEW_TASK_PLANNING_STORAGE_KEY = "clanky.newTaskPlanningPreferences";

export interface NewTaskPlanningPreferences {
  planMode: boolean;
  autoAcceptPlan: boolean;
  fullyAutonomous: boolean;
}

export interface NewTaskPlanningPreferenceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NewTaskPlanningPreferenceDependencies {
  storage?: NewTaskPlanningPreferenceStorageLike;
}

function resolveStorage(
  storage?: NewTaskPlanningPreferenceStorageLike,
): NewTaskPlanningPreferenceStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("New task planning preference storage is unavailable", {
      error: String(error),
    });
    return null;
  }
}

function isNewTaskPlanningPreferences(
  value: unknown,
): value is NewTaskPlanningPreferences {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["planMode"] === "boolean"
    && typeof candidate["autoAcceptPlan"] === "boolean"
    && typeof candidate["fullyAutonomous"] === "boolean"
  );
}

export function getStoredNewTaskPlanningPreferences(
  dependencies: NewTaskPlanningPreferenceDependencies = {},
): NewTaskPlanningPreferences | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(NEW_TASK_PLANNING_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isNewTaskPlanningPreferences(parsed)) {
      storage.removeItem(NEW_TASK_PLANNING_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch (error) {
    log.warn("Removing invalid stored new task planning preferences", {
      storageKey: NEW_TASK_PLANNING_STORAGE_KEY,
      error: String(error),
    });
    try {
      storage.removeItem(NEW_TASK_PLANNING_STORAGE_KEY);
    } catch (cleanupError) {
      log.warn("Failed to clear invalid new task planning preferences", {
        storageKey: NEW_TASK_PLANNING_STORAGE_KEY,
        cleanupError: String(cleanupError),
      });
    }
    return null;
  }
}

export function saveStoredNewTaskPlanningPreferences(
  preferences: NewTaskPlanningPreferences,
  dependencies: NewTaskPlanningPreferenceDependencies = {},
): void {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return;
  }

  try {
    storage.setItem(NEW_TASK_PLANNING_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    log.warn("Failed to persist new task planning preferences", {
      storageKey: NEW_TASK_PLANNING_STORAGE_KEY,
      error: String(error),
    });
  }
}
