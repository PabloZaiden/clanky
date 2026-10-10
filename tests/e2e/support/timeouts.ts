/**
 * Shared fail-fast budgets for black-box E2E boundaries.
 */

export const OPERATION_TIMEOUT_MS = 5_000;
export const LIFECYCLE_TIMEOUT_MS = 10_000;

export function operationSignal(
  parentSignal?: AbortSignal | null,
  timeoutMs = OPERATION_TIMEOUT_MS,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}
