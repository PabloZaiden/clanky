/**
 * Coalesces refresh calls that target the same mounted resource.
 *
 * A new refresh shares the active promise instead of aborting the request that
 * is already recovering the resource. `reset` is reserved for an identity
 * change or teardown, where the next call must not reuse the old operation.
 * `runAfterCurrent` is for mutations that need a fresh operation after an
 * already-running refresh settles.
 */
export interface RefreshCoordinator<T> {
  run(operation: () => Promise<T> | T): Promise<T>;
  runAfterCurrent(operation: () => Promise<T> | T): Promise<T>;
  reset(): void;
}

export function createRefreshCoordinator<T>(): RefreshCoordinator<T> {
  let activePromise: Promise<T> | null = null;

  const run = (operation: () => Promise<T> | T): Promise<T> => {
    if (activePromise) {
      return activePromise;
    }

    const operationPromise = Promise.resolve().then(operation);
    const trackedPromise = operationPromise.finally(() => {
      if (activePromise === trackedPromise) {
        activePromise = null;
      }
    });
    activePromise = trackedPromise;
    return trackedPromise;
  };

  return {
    run,
    runAfterCurrent(operation) {
      const currentPromise = activePromise;
      if (!currentPromise) {
        return run(operation);
      }
      return currentPromise.then(
        () => run(operation),
        () => run(operation),
      );
    },
    reset() {
      activePromise = null;
    },
  };
}
