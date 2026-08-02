import { AsyncLocalStorage } from "node:async_hooks";

const meshReplicationContext = new AsyncLocalStorage<boolean>();

export function isMeshReplicationSuppressed(): boolean {
  return meshReplicationContext.getStore() === true;
}

export function runWithMeshReplicationSuppressed<T>(callback: () => T): T {
  return meshReplicationContext.run(true, callback);
}
