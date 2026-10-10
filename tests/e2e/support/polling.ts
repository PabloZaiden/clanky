/**
 * Shared bounded polling primitives for asynchronous tests.
 */

const DEFAULT_POLL_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface PollUntilOptions<T> {
  description: string;
  timeoutMs?: number;
  intervalMs?: number;
  formatLastObserved?: (value: T) => string;
}

/**
 * Poll an asynchronous observation until its predicate succeeds.
 */
export function pollUntil<T, U extends T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => value is U,
  options: PollUntilOptions<T>,
): Promise<U>;
export function pollUntil<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
  options: PollUntilOptions<T>,
): Promise<T>;
export async function pollUntil<T>(
  probe: () => T | Promise<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
  options: PollUntilOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`Polling timeout must be a finite non-negative number: ${timeoutMs}`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError(`Polling interval must be a finite non-negative number: ${intervalMs}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastObserved: T;

  while (true) {
    lastObserved = await probe();
    if (await predicate(lastObserved)) {
      return lastObserved;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await Bun.sleep(Math.min(intervalMs, remainingMs));
  }

  const formatLastObserved = options.formatLastObserved ?? ((value: T) => String(value));
  throw new Error(
    `Timed out waiting for ${options.description} within ${timeoutMs}ms. Last observed: ${formatLastObserved(lastObserved)}`,
  );
}
