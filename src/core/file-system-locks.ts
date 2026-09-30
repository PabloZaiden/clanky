/**
 * Controller-owned DAV locks. These coordinate DAV clients, not host processes.
 */

import { randomUUID } from "node:crypto";
import type { FileSystemConditions, FileSystemLock } from "../contracts/schemas/file-system";
import { DomainError } from "../domain/domain-error";
import { executionPathsEqual, relativeExecutionPath, type ExecutionPathStyle } from "./execution-path";

interface StoredLock extends FileSystemLock {
  key: string;
  ownerId: string;
  pathStyle: ExecutionPathStyle;
}

export function containsExecutionPath(parent: string, child: string, style: ExecutionPathStyle): boolean {
  const relative = relativeExecutionPath(parent, child, style);
  return relative === "" || (
    relative !== ".." && !relative.startsWith("../") && !relative.startsWith("..\\")
    && !(style === "windows" && relative.startsWith("\\"))
    && !relative.startsWith("/") && !/^[A-Za-z]:/.test(relative)
  );
}

export class FileSystemLocks {
  private readonly locks = new Map<string, StoredLock>();

  private active(key: string): StoredLock[] {
    for (const [token, lock] of this.locks) {
      if (lock.expiresAt <= Date.now()) this.locks.delete(token);
    }
    return [...this.locks.values()].filter((lock) => lock.key === key);
  }

  applicable(key: string, path: string): FileSystemLock[] {
    return this.active(key).filter((lock) => (
      executionPathsEqual(lock.path, path, lock.pathStyle)
      || (lock.depth === "infinity" && containsExecutionPath(lock.path, path, lock.pathStyle))
    )).map(({ path: root, token, scope, depth, owner, expiresAt }) => ({
      path: root, token, scope, depth, owner, expiresAt,
    }));
  }

  tokens(
    { key, path, etags, conditions, style }: {
      key: string; path: string; etags: readonly string[]; conditions?: FileSystemConditions; style: ExecutionPathStyle;
    },
  ): Set<string> {
    const lists = conditions?.davIf?.filter((list) => (
      list.path === undefined || executionPathsEqual(list.path, path, style)
    ));
    const supplied = new Set<string>();
    if (!lists?.length) return supplied;
    const active = new Set(this.applicable(key, path).map((lock) => lock.token));
    let matched = false;
    for (const list of lists) {
      const matches = list.terms.every((term) => {
        const value = term.kind === "token"
          ? active.has(term.value)
          : etags.some((etag) => term.value.replace(/^W\//, "") === etag.replace(/^W\//, ""));
        return term.not ? !value : value;
      });
      if (matches) {
        matched = true;
        for (const term of list.terms) {
          if (term.kind === "token" && !term.not && active.has(term.value)) {
            supplied.add(term.value);
          }
        }
      }
    }
    if (!matched) {
      throw new DomainError("file_system_precondition_failed", "DAV conditions did not match.");
    }
    return supplied;
  }

  assertWritable(
    { key, path, supplied, recursive = false }: {
      key: string; path: string; supplied: Set<string>; recursive?: boolean;
    },
  ): void {
    const locks = this.active(key).filter((lock) => (
      executionPathsEqual(lock.path, path, lock.pathStyle)
      || (lock.depth === "infinity" && containsExecutionPath(lock.path, path, lock.pathStyle))
      || (recursive && containsExecutionPath(path, lock.path, lock.pathStyle))
    ));
    for (const lock of locks) {
      const satisfied = lock.scope === "exclusive" ? supplied.has(lock.token) : locks.some((other) => (
        other.scope === "shared" && executionPathsEqual(other.path, lock.path, lock.pathStyle)
        && supplied.has(other.token)
      ));
      if (!satisfied) throw new DomainError("file_system_locked", "A DAV lock token is required.");
    }
  }

  create(input: Omit<StoredLock, "token" | "expiresAt">, timeoutSeconds: number): FileSystemLock {
    const active = this.active(input.key);
    if (this.locks.size >= 2_048 || active.length >= 256) {
      throw new DomainError("file_system_busy", "DAV lock capacity reached.");
    }
    if (active.some((lock) => (
      (lock.scope === "exclusive" || input.scope === "exclusive")
      && (executionPathsEqual(lock.path, input.path, input.pathStyle)
        || (lock.depth === "infinity" && containsExecutionPath(lock.path, input.path, input.pathStyle))
        || (input.depth === "infinity" && containsExecutionPath(input.path, lock.path, input.pathStyle)))
    ))) {
      throw new DomainError("file_system_locked", "The resource is already locked.");
    }
    const lock: StoredLock = {
      ...input,
      token: `urn:uuid:${randomUUID()}`,
      expiresAt: Date.now() + timeoutSeconds * 1_000,
    };
    this.locks.set(lock.token, lock);
    return this.publicLock(lock);
  }

  refresh({ key, path, ownerId, tokens, seconds }: {
    key: string; path: string; ownerId: string; tokens: Set<string>; seconds: number;
  }): FileSystemLock {
    const lock = this.active(key).find((entry) => (
      entry.ownerId === ownerId && tokens.has(entry.token)
      && executionPathsEqual(entry.path, path, entry.pathStyle)
    ));
    if (!lock) throw new DomainError("file_system_precondition_failed", "No matching DAV lock.");
    lock.expiresAt = Date.now() + seconds * 1_000;
    return this.publicLock(lock);
  }

  private publicLock(lock: StoredLock): FileSystemLock {
    const { path, token, scope, depth, owner, expiresAt } = lock;
    return { path, token, scope, depth, owner, expiresAt };
  }

  unlock({ key, path, token, ownerId }: { key: string; path: string; token: string; ownerId: string }): void {
    const lock = this.active(key).find((entry) => (
      entry.token === token && entry.ownerId === ownerId
      && executionPathsEqual(entry.path, path, entry.pathStyle)
    ));
    if (!lock) throw new DomainError("file_system_conflict", "No matching DAV lock.");
    this.locks.delete(token);
  }

  rollback(key: string, token: string, ownerId: string): void {
    const lock = this.locks.get(token);
    // A failed acquisition can outlive its lease; expiry already owns cleanup.
    if (!lock) return;
    if (lock.key !== key || lock.ownerId !== ownerId) {
      throw new DomainError("file_system_forbidden", "DAV lock ownership changed.");
    }
    this.locks.delete(token);
  }

  release(key: string, ownerId: string): void {
    for (const lock of this.active(key)) {
      if (lock.ownerId === ownerId) this.locks.delete(lock.token);
    }
  }

  remove(key: string, path: string, style: ExecutionPathStyle): void {
    for (const lock of this.active(key)) {
      if (containsExecutionPath(path, lock.path, style)) this.locks.delete(lock.token);
    }
  }
}
