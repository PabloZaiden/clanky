/**
 * Short IndexedDB transactions with explicit completion and failure ownership.
 */

import { DomainError } from "../../domain/domain-error";

export interface BrowserStorageOperation<T> {
  result(value: T): void;
  request<V>(request: IDBRequest<V>, next: (value: V) => void): void;
}

export async function browserStorageTransaction<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction, task: BrowserStorageOperation<T>) => void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : {});
      if (mode === "readwrite" && transaction.durability !== "strict") {
        transaction.abort();
        reject(new DomainError("collaboration_browser_unsupported", "This browser cannot durably commit pairing identities."));
        return;
      }
    } catch (error) {
      reject(new DomainError("collaboration_storage_unavailable", "Browser pairing storage is unavailable.", { cause: error }));
      return;
    }
    let value: T;
    let hasResult = false;
    let failure: unknown;
    const fail = (error: unknown): void => {
      failure = error;
      transaction.abort();
    };
    const task: BrowserStorageOperation<T> = {
      result(result: T): void {
        value = result;
        hasResult = true;
      },
      request<V>(request: IDBRequest<V>, next: (result: V) => void): void {
        request.onsuccess = (): void => {
          try {
            next(request.result);
          } catch (error) {
            fail(error);
          }
        };
      },
    };
    transaction.oncomplete = (): void => {
      if (hasResult) resolve(value);
      else reject(new DomainError("collaboration_storage_failed", "Browser pairing storage did not complete its operation."));
    };
    transaction.onabort = (): void => {
      reject(failure instanceof DomainError ? failure : new DomainError(
        "collaboration_storage_failed", "Browser pairing storage could not complete the operation.",
        { cause: failure ?? transaction.error },
      ));
    };
    try {
      operation(transaction, task);
    } catch (error) {
      fail(error);
    }
  });
}

export async function openBrowserPairingDatabase(name: string): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let settled = false;
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => finishError(new DomainError(
      "collaboration_storage_unavailable", "Browser pairing storage did not open in time. Close other Clanky tabs and retry.",
    )), 5_000);
    request.onupgradeneeded = (): void => {
      const database = request.result;
      if (!database.objectStoreNames.contains("metadata")) database.createObjectStore("metadata");
      if (!database.objectStoreNames.contains("pairings")) {
        database.createObjectStore("pairings", { keyPath: "connection.id" });
      }
    };
    request.onsuccess = (): void => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = (): void => finishError(new DomainError(
      "collaboration_storage_unavailable", "Browser pairing storage could not be opened.", { cause: request.error },
    ));
    request.onblocked = (): void => finishError(new DomainError(
      "collaboration_connection_in_use", "Close other Clanky tabs before upgrading browser pairing storage.",
    ));
  });
}
