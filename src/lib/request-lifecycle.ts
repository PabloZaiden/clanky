export const SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000;

export function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

export function isTimeoutError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "TimeoutError";
}
