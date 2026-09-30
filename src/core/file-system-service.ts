/**
 * Transport-neutral filesystem operations for DAV and exact-path API clients.
 * The initial directory is a navigation base, deliberately not a sandbox.
 */

import { randomUUID } from "node:crypto";
import type {
  FileSystemCommand, FileSystemConditions, FileSystemEntry, FileSystemInfo, FileSystemResult,
} from "../contracts/schemas/file-system";
import { FILE_SYSTEM_MAX_METADATA_BYTES } from "../contracts/schemas/file-system";
import { requireCurrentUserId } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import type { FileStreamOptions, FileSystemMetadata } from "./command-executor";
import type { FileExplorerTarget } from "./file-explorer-service";
import {
  basenameExecutionPath, dirnameExecutionPath, executionPathsEqual, joinExecutionPath,
  normalizeExecutionRoot, resolveExecutionPathUnscoped,
} from "./execution-path";
import { containsExecutionPath, FileSystemLocks } from "./file-system-locks";

export const FILE_SYSTEM_MAX_ENTRIES = 10_000;
export const FILE_SYSTEM_MAX_DEPTH = 128;
const MAX_PENDING_PER_TARGET = 64;
const MAX_PENDING_GLOBAL = 256;

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DomainError("file_system_aborted", "Filesystem operation cancelled.", { cause: signal.reason });
  }
}

export function fileSystemTargetFingerprint(values: readonly unknown[]): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(values)).digest("hex");
}

function pathFor(target: FileExplorerTarget, path: string): string {
  try {
    return resolveExecutionPathUnscoped(target.rootDirectory, path, target.executor.pathStyle);
  } catch (error) {
    throw new DomainError("file_system_invalid_path", "Invalid filesystem path.", { cause: error });
  }
}

function entryFor(target: FileExplorerTarget, path: string, metadata: FileSystemMetadata): FileSystemEntry {
  return {
    ...metadata,
    path,
    name: basenameExecutionPath(path, target.executor.pathStyle),
    etag: metadata.contentHash
      ? `"${metadata.contentHash}"`
      : weakEtag(metadata),
  };
}

function weakEtag(metadata: Pick<FileSystemMetadata, "modifiedAtMs" | "size">): string {
  return `W/"${String(metadata.modifiedAtMs)}-${String(metadata.size)}"`;
}

function requiresHash(conditions?: FileSystemConditions): boolean {
  return [conditions?.ifMatch, conditions?.ifNoneMatch].some((value) => value !== undefined && value.trim() !== "*")
    || conditions?.davIf?.some((list) => list.terms.some((term) => term.kind === "etag" && !term.value.startsWith("W/"))) === true;
}

interface StagedPath {
  path: string;
  committed: boolean;
}

interface FileConditionContext {
  target: FileExplorerTarget;
  path: string;
  conditions?: FileSystemConditions;
  recursive?: boolean;
}

interface FileMutationContext<T> {
  target: FileExplorerTarget;
  path: string;
  command: T;
  signal?: AbortSignal;
}

function assertPreconditions(entry: FileSystemEntry | null, conditions?: FileSystemConditions): void {
  const matches = (header: string, strong: boolean): boolean => (
    header.trim() === "*" ? entry !== null : header.split(",").some((value) => {
      const tag = value.trim();
      if (strong && (tag.startsWith("W/") || entry?.etag.startsWith("W/"))) return false;
      return entry !== null && tag.replace(/^W\//, "") === entry.etag.replace(/^W\//, "");
    })
  );
  if (
    (conditions?.ifMatch !== undefined && !matches(conditions.ifMatch, true))
    || (conditions?.ifNoneMatch !== undefined && matches(conditions.ifNoneMatch, false))
  ) {
    throw new DomainError("file_system_precondition_failed", "The resource changed.");
  }
}

export class FileSystemService {
  private readonly locks = new FileSystemLocks();
  private readonly queues = new Map<string, { tail: Promise<void>; pending: number }>();
  private pending = 0;

  private key(target: FileExplorerTarget): string {
    return `${requireCurrentUserId()}:${target.fileSystemIdentity ?? target.id}`;
  }

  private async serialize<T>(target: FileExplorerTarget, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertActive(signal);
    const key = target.fileSystemIdentity ?? target.id;
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= MAX_PENDING_PER_TARGET || this.pending >= MAX_PENDING_GLOBAL) {
      throw new DomainError("file_system_busy", "Filesystem operation capacity reached.");
    }
    this.queues.set(key, queue);
    this.pending += 1;
    queue.pending += 1;
    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      assertActive(signal);
      return await action();
    } finally {
      this.pending -= 1;
      queue.pending -= 1;
      release();
      if (queue.pending === 0) this.queues.delete(key);
    }
  }

  info(target: FileExplorerTarget): FileSystemInfo {
    return {
      directory: normalizeExecutionRoot(target.rootDirectory, target.executor.pathStyle),
      pathStyle: target.executor.pathStyle,
      target: target.fileSystemTarget ?? target.id,
      commandExecution: target.commandExecutionAvailable === true,
    };
  }

  async stat(target: FileExplorerTarget, requested: string, hash = false): Promise<FileSystemEntry | null> {
    const path = pathFor(target, requested);
    let metadata = await target.executor.getFileMetadata(path, { includeContentHash: false });
    if (hash && metadata?.kind === "file") {
      if (!await target.executor.fileExists(path)) {
        throw new DomainError("file_system_invalid_type", "A regular file is required.");
      }
      metadata = await target.executor.getFileMetadata(path, { includeContentHash: true });
    }
    return metadata ? entryFor(target, path, metadata) : null;
  }

  private async requireEntry(target: FileExplorerTarget, path: string, hash = false): Promise<FileSystemEntry> {
    const entry = await this.stat(target, path, hash);
    if (!entry) throw new DomainError("file_system_not_found", "The resource does not exist.");
    return entry;
  }

  private async parent(target: FileExplorerTarget, path: string): Promise<void> {
    const entry = await this.stat(target, dirnameExecutionPath(path, target.executor.pathStyle));
    if (entry?.kind !== "directory") {
      throw new DomainError("file_system_conflict", "The destination parent must exist.");
    }
  }

  private async check(
    { target, path, conditions, recursive = false }: FileConditionContext,
  ): Promise<FileSystemEntry | null> {
    const entry = await this.stat(target, path, requiresHash(conditions));
    assertPreconditions(entry, conditions);
    const key = this.key(target);
    const tokens = await this.conditionTokens({ target, path, entry, conditions });
    this.locks.assertWritable({ key, path, supplied: tokens, recursive });
    return entry;
  }

  private async conditionTokens(
    { target, path, entry, conditions }: FileConditionContext & { entry: FileSystemEntry | null },
  ): Promise<Set<string>> {
    const style = target.executor.pathStyle;
    const normalized = {
      davIf: conditions?.davIf?.map((list) => ({
        ...list, ...(list.path === undefined ? {} : { path: pathFor(target, list.path) }),
      })),
    };
    const tags = (node: FileSystemEntry | null) => node ? [node.etag, weakEtag(node)] : [];
    const key = this.key(target);
    const tokens = this.locks.tokens({ key, path, etags: tags(entry), conditions: normalized, style });
    const taggedPaths = new Set(normalized.davIf?.flatMap((list) => (
      list.path !== undefined && !executionPathsEqual(list.path, path, style)
        ? [list.path] : []
    )));
    for (const tagged of taggedPaths) {
      const lists = normalized.davIf?.filter((list) => list.path !== undefined);
      const node = await this.stat(target, tagged, requiresHash({ davIf: lists }));
      for (const token of this.locks.tokens({
        key, path: tagged, etags: tags(node), conditions: { davIf: lists }, style,
      })) {
        tokens.add(token);
      }
    }
    return tokens;
  }

  private async command({ target, posix, powershell, paths, signal }: {
    target: FileExplorerTarget; posix: string[]; powershell: string; paths: string[]; signal?: AbortSignal;
  }): Promise<void> {
    assertActive(signal);
    if (!target.commandExecutionAvailable) {
      throw new DomainError("execution_host_capability_unavailable", "commandExecution is required for this operation.");
    }
    const env = Object.fromEntries(paths.map((path, index) => [`CLANKY_FILE_PATH_${String(index)}`, path]));
    const result = target.executor.pathStyle === "windows"
      ? await target.executor.exec("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${powershell}`,
        ], { env, signal, timeout: 120_000 })
      : await target.executor.exec(posix[0]!, [...posix.slice(1), ...paths], { signal, timeout: 120_000 });
    if (!result.success) {
      throw new DomainError("file_system_operation_failed", "Filesystem command failed.", {
        details: { exitCode: result.exitCode },
      });
    }
  }

  private async mkdir(target: FileExplorerTarget, path: string, signal?: AbortSignal): Promise<void> {
    await this.parent(target, path);
    await this.command({
      target, posix: ["mkdir", "--"],
      powershell: "[IO.Directory]::CreateDirectory($env:CLANKY_FILE_PATH_0) | Out-Null",
      paths: [path], signal,
    });
  }

  async list(target: FileExplorerTarget, path: string): Promise<FileSystemResult> {
    const entry = await this.requireEntry(target, path);
    if (entry.kind !== "directory") return { entry, entries: [], locks: this.locks.applicable(this.key(target), entry.path) };
    const nodes = await target.executor.listDirectoryEntries(entry.path, { includeHidden: true });
    if (nodes.length > FILE_SYSTEM_MAX_ENTRIES) {
      throw new DomainError("file_system_limit", "Directory listing limit exceeded.");
    }
    const entries: FileSystemEntry[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(entry));
    for (let offset = 0; offset < nodes.length; offset += 16) {
      const batch = await Promise.all(nodes.slice(offset, offset + 16).map(async (node) => {
        const path = joinExecutionPath(target.executor.pathStyle, entry.path, node.name);
        return await this.stat(target, path);
      }));
      bytes += Buffer.byteLength(JSON.stringify(batch));
      if (bytes > FILE_SYSTEM_MAX_METADATA_BYTES) {
        throw new DomainError("file_system_limit", "Directory metadata size limit exceeded.");
      }
      entries.push(...batch.filter((node): node is FileSystemEntry => node !== null));
    }
    const locks = new Map([entry, ...entries].flatMap((node) => (
      this.locks.applicable(this.key(target), node.path).map((lock) => [lock.token, lock] as const)
    )));
    const result = { entry, entries, locks: [...locks.values()] };
    if (Buffer.byteLength(JSON.stringify(result)) > FILE_SYSTEM_MAX_METADATA_BYTES) {
      throw new DomainError("file_system_limit", "Directory metadata size limit exceeded.");
    }
    return result;
  }

  private async assertRecursiveBudget({ target, entry, signal, followRootLink = false }: {
    target: FileExplorerTarget; entry: FileSystemEntry; signal?: AbortSignal; followRootLink?: boolean;
  }): Promise<void> {
    if (entry.kind !== "directory" || (entry.isSymbolicLink && !followRootLink)) return;
    const pending = [{ path: entry.path, depth: 0 }];
    let count = 0;
    for (let index = 0; index < pending.length; index += 1) {
      assertActive(signal);
      const directory = pending[index]!;
      if (directory.depth > FILE_SYSTEM_MAX_DEPTH) {
        throw new DomainError("file_system_limit", "Recursive directory depth limit exceeded.");
      }
      const entries = await target.executor.listDirectoryEntries(directory.path, { includeHidden: true });
      count += entries.length;
      if (count > FILE_SYSTEM_MAX_ENTRIES) throw new DomainError("file_system_limit", "Recursive entry limit exceeded.");
      for (const node of entries) {
        if (node.kind === "directory" && !node.isSymbolicLink) pending.push({
          path: joinExecutionPath(target.executor.pathStyle, directory.path, node.name),
          depth: directory.depth + 1,
        });
      }
    }
  }

  async execute(target: FileExplorerTarget, command: FileSystemCommand, signal?: AbortSignal): Promise<FileSystemResult | FileSystemInfo> {
    if (command.operation === "info") return this.info(target);
    if (command.operation === "stat") {
      const entry = await this.stat(target, command.path, command.hash);
      return { entry, locks: this.locks.applicable(this.key(target), pathFor(target, command.path)) };
    }
    if (command.operation === "list") return await this.list(target, command.path);
    return await this.serialize(target, async () => {
      if (command.operation === "releaseLocks") {
        this.locks.release(this.key(target), command.ownerId);
        return {};
      }
      const path = pathFor(target, command.path);
      const key = this.key(target);
      if (command.operation === "unlock") {
        this.locks.unlock({ key, path, token: command.token, ownerId: command.ownerId });
        return {};
      }
      if (command.operation === "refreshLock") {
        const entry = await this.stat(target, path, requiresHash(command.conditions));
        assertPreconditions(entry, command.conditions);
        const tokens = await this.conditionTokens({ target, path, entry, conditions: command.conditions });
        assertActive(signal);
        return { lock: this.locks.refresh({ key, path, ownerId: command.ownerId, tokens, seconds: command.timeoutSeconds }) };
      }
      if (command.operation === "lock") return await this.lock({ target, path, command, signal });
      if (command.operation === "move" || command.operation === "copy") {
        return await this.transfer({ target, path, command, signal });
      }
      const entry = await this.check({ target, path, conditions: command.conditions, recursive: command.operation === "delete" });
      if (command.operation === "mkdir") {
        if (entry) throw new DomainError("file_system_exists", "The resource already exists.");
        await this.mkdir(target, path, signal);
        return { entry: await this.requireEntry(target, path), created: true };
      }
      if (!entry) throw new DomainError("file_system_not_found", "The resource does not exist.");
      if (executionPathsEqual(path, dirnameExecutionPath(path, target.executor.pathStyle), target.executor.pathStyle)) {
        throw new DomainError("file_system_forbidden", "The host filesystem root cannot be deleted.");
      }
      await this.assertRecursiveBudget({ target, entry, signal });
      assertActive(signal);
      if (!await target.executor.deletePath(path, { kind: entry.kind, recursive: entry.kind === "directory" })) {
        throw new DomainError("file_system_operation_failed", "Deletion failed.");
      }
      this.locks.remove(key, path, target.executor.pathStyle);
      return {};
    }, signal);
  }

  private async lock(
    { target, path, command, signal }: FileMutationContext<Extract<FileSystemCommand, { operation: "lock" }>>,
  ): Promise<FileSystemResult> {
    const entry = await this.stat(target, path, requiresHash(command.conditions));
    assertPreconditions(entry, command.conditions);
    await this.conditionTokens({ target, path, entry, conditions: command.conditions });
    if (!entry) await this.parent(target, path);
    assertActive(signal);
    const lock = this.locks.create({
      key: this.key(target), path, ownerId: command.ownerId, scope: command.scope,
      depth: command.depth, owner: command.owner, pathStyle: target.executor.pathStyle,
    }, command.timeoutSeconds);
    try {
      if (!entry) {
        await this.withStagedPath({ target, destination: path, kind: "file" }, async (stage) => {
          assertActive(signal);
          if (!await target.executor.writeFile(stage.path, "")) {
            throw new DomainError("file_system_operation_failed", "Could not create the locked resource.");
          }
          assertActive(signal);
          const moved = await target.executor.movePath(stage.path, path, { overwrite: false });
          if (!moved.success) throw new DomainError("file_system_conflict", "The lock resource could not be created.");
          stage.committed = true;
        });
      }
      return { lock, created: !entry };
    } catch (error) {
      this.locks.rollback(this.key(target), lock.token, command.ownerId);
      throw error;
    }
  }

  private async transfer(
    { target, path, command, signal }: FileMutationContext<Extract<FileSystemCommand, { operation: "move" | "copy" }>>,
  ): Promise<FileSystemResult> {
    const source = command.operation === "move"
      ? await this.check({ target, path, conditions: command.conditions, recursive: true })
      : await this.stat(target, path, requiresHash(command.conditions));
    if (!source) throw new DomainError("file_system_not_found", "The source does not exist.");
    if (command.operation === "copy" && source.kind === "file" && !await target.executor.fileExists(path)) {
      throw new DomainError("file_system_invalid_type", "A regular source file is required.");
    }
    if (command.operation === "copy") {
      assertPreconditions(source, command.conditions);
      await this.conditionTokens({ target, path, entry: source, conditions: command.conditions });
    }
    const destination = pathFor(target, command.destination);
    if (executionPathsEqual(path, destination, target.executor.pathStyle)) {
      throw new DomainError("file_system_forbidden", "Source and destination must differ.");
    }
    if (command.operation === "move"
      && executionPathsEqual(path, dirnameExecutionPath(path, target.executor.pathStyle), target.executor.pathStyle)) {
      throw new DomainError("file_system_forbidden", "The host filesystem root cannot be moved.");
    }
    if (source.kind === "directory" && containsExecutionPath(path, destination, target.executor.pathStyle)) {
      throw new DomainError("file_system_forbidden", "A directory cannot be copied or moved into itself.");
    }
    await this.parent(target, destination);
    const existing = await this.stat(target, destination, Boolean(command.conditions?.davIf));
    const destinationConditions = {
      davIf: command.conditions?.davIf?.filter((list) => list.path !== undefined),
    };
    const tokens = await this.conditionTokens({ target, path: destination, entry: existing, conditions: destinationConditions });
    this.locks.assertWritable({ key: this.key(target), path: destination, supplied: tokens, recursive: true });
    if (existing && !command.overwrite) throw new DomainError("file_system_precondition_failed", "The destination exists.");
    if (existing && (existing.kind !== source.kind || source.kind === "directory")) {
      throw new DomainError("file_system_conflict", "Directory replacement is not supported.");
    }
    if (command.operation === "copy" && command.depth === "infinity") {
      await this.assertRecursiveBudget({ target, entry: source, signal, followRootLink: true });
    }
    if (command.operation === "move") {
      assertActive(signal);
      const result = await target.executor.movePath(path, destination, { overwrite: command.overwrite });
      if (!result.success) throw new DomainError("file_system_conflict", "The resource could not be moved.");
      this.locks.remove(this.key(target), path, target.executor.pathStyle);
    } else {
      await this.withStagedPath({ target, destination, kind: source.kind }, async (stage) => {
        if (source.kind === "directory" && command.depth === "0") await this.mkdir(target, stage.path, signal);
        else await this.command({
          target, posix: source.kind === "directory" ? ["cp", "-R", "-H", "--"] : ["cp", "--"],
          powershell: "Copy-Item -LiteralPath $env:CLANKY_FILE_PATH_0 -Destination $env:CLANKY_FILE_PATH_1"
            + (source.kind === "directory" ? " -Recurse" : ""),
          paths: [path, stage.path], signal,
        });
        assertActive(signal);
        const moved = await target.executor.movePath(stage.path, destination, { overwrite: command.overwrite });
        if (!moved.success) throw new DomainError("file_system_conflict", "Copy replacement failed.");
        stage.committed = true;
      });
    }
    return { entry: await this.requireEntry(target, destination), overwritten: Boolean(existing) };
  }

  async read(target: FileExplorerTarget, entry: FileSystemEntry, options?: FileStreamOptions) {
    if (entry.kind !== "file" || !await target.executor.fileExists(entry.path)) {
      throw new DomainError("file_system_invalid_type", "A regular file is required.");
    }
    assertActive(options?.signal);
    const stream = await target.executor.streamFile(entry.path, options);
    if (!stream) throw new DomainError("file_system_not_found", "The file could not be read.");
    return { entry, stream };
  }

  async write({ target, path, stream, conditions, signal }: {
    target: FileExplorerTarget; path: string; stream: ReadableStream<Uint8Array>;
    conditions: FileSystemConditions; signal?: AbortSignal;
  }): Promise<FileSystemResult> {
    const absolute = pathFor(target, path);
    await this.parent(target, absolute);
    const existing = await this.check({ target, path: absolute, conditions });
    if (existing?.kind === "directory") throw new DomainError("file_system_conflict", "A file cannot replace a directory.");
    if (!target.executor.writeFileStream) throw new DomainError("file_system_operation_failed", "Streamed writes are unavailable.");
    const write = target.executor.writeFileStream.bind(target.executor);
    return await this.withStagedPath({ target, destination: absolute, kind: "file" }, async (stage) => {
      assertActive(signal);
      const wrote = await write(stage.path, stream, { signal });
      assertActive(signal);
      if (!wrote.success) throw new DomainError("file_system_operation_failed", "File transfer failed.");
      return await this.serialize(target, async () => {
        const current = await this.check({ target, path: absolute, conditions });
        if (current?.kind === "directory") throw new DomainError("file_system_conflict", "A file cannot replace a directory.");
        assertActive(signal);
        const moved = await target.executor.movePath(stage.path, absolute, { overwrite: Boolean(current) });
        if (!moved.success) throw new DomainError("file_system_conflict", "File replacement failed.");
        stage.committed = true;
        return { entry: await this.requireEntry(target, absolute, true), created: !current };
      }, signal);
    });
  }

  private async withStagedPath<T>(
    { target, destination, kind }: { target: FileExplorerTarget; destination: string; kind: "file" | "directory" },
    action: (stage: StagedPath) => Promise<T>,
  ): Promise<T> {
    const stage = {
      path: joinExecutionPath(target.executor.pathStyle, dirnameExecutionPath(destination, target.executor.pathStyle), `.clanky-upload-${randomUUID()}.tmp`),
      committed: false,
    };
    let failure: { error: unknown } | undefined;
    try {
      return await action(stage);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      if (!stage.committed) {
        try {
          if (!await target.executor.deletePath(stage.path, { kind, recursive: kind === "directory" })
            && await this.stat(target, stage.path)) {
            throw new Error("The temporary transfer still exists.");
          }
        } catch (error) {
          throw new DomainError("file_system_cleanup_failed", "Temporary transfer cleanup failed.", {
            cause: failure ? new AggregateError([failure.error, error], "Transfer and cleanup failed.") : error,
          });
        }
      }
    }
  }
}

export const fileSystemService = new FileSystemService();
