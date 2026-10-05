/**
 * Serializes workspace execution-target mutations with terminal lifecycle
 * operations inside this Clanky process.
 */

const workspaceExecutionLocks = new Map<string, Promise<void>>();
const workspaceRuntimeLocks = new Map<string, Promise<void>>();

export async function withWorkspaceExecutionLock<T>(
  workspaceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await withLock(workspaceExecutionLocks, workspaceId, operation);
}

/** Keeps runtime saves and automated container lifecycle jobs consistent. */
export async function withWorkspaceRuntimeLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  return await withLock(workspaceRuntimeLocks, workspaceId, operation);
}

async function withLock<T>(locks: Map<string, Promise<void>>, workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(workspaceId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(workspaceId, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (locks.get(workspaceId) === queued) {
      locks.delete(workspaceId);
    }
  }
}
