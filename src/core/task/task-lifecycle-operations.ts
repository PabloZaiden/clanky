import { KeyedOperationQueue } from "../../utils/keyed-operation-queue";

const taskLifecycleOperations = new KeyedOperationQueue();

export function runTaskLifecycleOperation<T>(
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return taskLifecycleOperations.run(taskId, operation);
}

export function runTaskLifecycleOperationWithDeferredCleanup<T>(
  taskId: string,
  operation: (deferCleanup: (cleanup: () => Promise<void>) => void) => Promise<T>,
  onCleanupError: (error: unknown) => void,
): Promise<T> {
  let resolveCleanup!: (cleanup: () => Promise<void>) => void;
  let cleanupScheduled = false;
  const cleanupReady = new Promise<() => Promise<void>>((resolve) => {
    resolveCleanup = resolve;
  });

  const operationPromise = taskLifecycleOperations.run(taskId, async () => {
    const deferCleanup = (cleanup: () => Promise<void>): void => {
      if (cleanupScheduled) {
        throw new Error(`Deferred cleanup was already scheduled for task ${taskId}.`);
      }
      cleanupScheduled = true;
      resolveCleanup(cleanup);
    };

    try {
      return await operation(deferCleanup);
    } finally {
      if (!cleanupScheduled) {
        resolveCleanup(async () => {});
      }
    }
  }).catch((error: unknown) => {
    if (!cleanupScheduled) {
      resolveCleanup(async () => {});
    }
    throw error;
  });

  // Reserve this queue position before later same-task operations can overtake cleanup.
  const cleanupPromise = taskLifecycleOperations.run(taskId, async () => {
    const cleanup = await cleanupReady;
    await cleanup();
  });
  void cleanupPromise.catch(onCleanupError);

  return operationPromise;
}
