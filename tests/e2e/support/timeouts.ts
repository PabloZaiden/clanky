/**
 * Shared fail-fast budgets for black-box E2E boundaries.
 */

export const OPERATION_TIMEOUT_MS = 5_000;
export const LIFECYCLE_TIMEOUT_MS = 10_000;

export function operationSignal(
  parentSignal?: AbortSignal | null,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}
