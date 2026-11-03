import { createLogger } from "@pablozaiden/webapp/web";

type StorageOperation = "get" | "set" | "remove";

export type StorageFailureReason = "unavailable" | "error";

export interface StorageFailure {
  ok: false;
  reason: StorageFailureReason;
  error: Error;
}

export type StorageReadResult = { ok: true; value: string | null } | StorageFailure;
export type StorageWriteResult = { ok: true } | StorageFailure;

export type StorageWarningCode =
  | "invalid-value"
  | "encoding-failed"
  | "unavailable"
  | "read-failed"
  | "write-failed";

const storageLogger = createLogger("webapp:storage");
const reportedWarnings = new Set<string>();

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  try {
    return new Error(String(value));
  } catch {
    return new Error("Browser storage operation failed.");
  }
}

function warningCodeFor(operation: StorageOperation): StorageWarningCode {
  return operation === "get" ? "read-failed" : "write-failed";
}

function reportWarning(key: string, code: StorageWarningCode, error?: Error): void {
  const signature = `${code}:${key}`;
  if (reportedWarnings.has(signature)) {
    return;
  }
  reportedWarnings.add(signature);
  storageLogger.warn("Browser storage operation failed.", {
    key,
    code,
    ...(error ? { error: error.message } : {}),
  });
}

export function warnStorageIssue(key: string, code: StorageWarningCode): void {
  if (code === "invalid-value") {
    const signature = `${code}:${key}`;
    if (reportedWarnings.has(signature)) {
      return;
    }
    reportedWarnings.add(signature);
    storageLogger.warn("Invalid browser storage value ignored.", { key, code });
    return;
  }
  if (code === "encoding-failed") {
    const signature = `${code}:${key}`;
    if (reportedWarnings.has(signature)) {
      return;
    }
    reportedWarnings.add(signature);
    storageLogger.warn("Browser storage value could not be encoded.", { key, code });
    return;
  }
  reportWarning(key, code);
}

function unavailableFailure(key: string): StorageFailure {
  const error = new Error("Browser localStorage is unavailable.");
  if (typeof window !== "undefined") {
    reportWarning(key, "unavailable", error);
  }
  return { ok: false, reason: "unavailable", error };
}

function resolveStorage(operation: StorageOperation, key: string): Storage | StorageFailure {
  if (typeof window === "undefined") {
    return unavailableFailure(key);
  }

  try {
    const storage = window.localStorage;
    if (!storage) {
      return unavailableFailure(key);
    }
    return storage;
  } catch (value) {
    const error = toError(value);
    reportWarning(key, warningCodeFor(operation), error);
    return { ok: false, reason: "error", error };
  }
}

function isStorageFailure(value: Storage | StorageFailure): value is StorageFailure {
  return "ok" in value && value.ok === false;
}

export function readStorage(key: string): StorageReadResult {
  const resolved = resolveStorage("get", key);
  if (isStorageFailure(resolved)) {
    return resolved;
  }

  try {
    if (typeof resolved.getItem !== "function") {
      throw new Error("Browser localStorage getItem is unavailable.");
    }
    return { ok: true, value: resolved.getItem(key) };
  } catch (value) {
    const error = toError(value);
    reportWarning(key, "read-failed", error);
    return { ok: false, reason: "error", error };
  }
}

export function writeStorage(key: string, value: string): StorageWriteResult {
  const resolved = resolveStorage("set", key);
  if (isStorageFailure(resolved)) {
    return resolved;
  }

  try {
    if (typeof resolved.setItem !== "function") {
      throw new Error("Browser localStorage setItem is unavailable.");
    }
    resolved.setItem(key, value);
    return { ok: true };
  } catch (value) {
    const error = toError(value);
    reportWarning(key, "write-failed", error);
    return { ok: false, reason: "error", error };
  }
}

export function removeStorage(key: string): StorageWriteResult {
  const resolved = resolveStorage("remove", key);
  if (isStorageFailure(resolved)) {
    return resolved;
  }

  try {
    if (typeof resolved.removeItem !== "function") {
      throw new Error("Browser localStorage removeItem is unavailable.");
    }
    resolved.removeItem(key);
    return { ok: true };
  } catch (value) {
    const error = toError(value);
    reportWarning(key, "write-failed", error);
    return { ok: false, reason: "error", error };
  }
}
