/**
 * Helpers for asynchronous operations with shared lifecycle ownership.
 */

export function createIdempotentAsyncOperation<T>(
  operation: () => Promise<T>,
): () => Promise<T> {
  let operationPromise: Promise<T> | undefined;
  return () => operationPromise ??= Promise.resolve().then(operation);
}
