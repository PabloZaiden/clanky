/**
 * Serializes workspace execution-target mutations with terminal lifecycle
 * operations inside this Clanky process.
 */

const workspaceExecutionLocks = new Map<string, Promise<void>>();

export async function withWorkspaceExecutionLock<T>(
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = workspaceExecutionLocks.get(workspaceId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  workspaceExecutionLocks.set(workspaceId, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (workspaceExecutionLocks.get(workspaceId) === queued) {
      workspaceExecutionLocks.delete(workspaceId);
    }
  }
}
