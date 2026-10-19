/**
 * Helpers for asynchronous operations with shared lifecycle ownership.
 */

export function createIdempotentAsyncOperation<T>(
  operation: () => Promise<T>,
): () => Promise<T> {
  let operationPromise: Promise<T> | undefined;
  return () => operationPromise ??= Promise.resolve().then(operation);
}

export function createRetryableAsyncOperation<T>(
  operation: () => Promise<T>,
): () => Promise<T> {
  let operationPromise: Promise<T> | undefined;
  return () => operationPromise ??= Promise.resolve().then(operation).catch((error: unknown) => {
    operationPromise = undefined;
    throw error;
  });
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
