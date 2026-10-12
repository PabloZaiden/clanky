/**
 * Executor-backed traversal shared by native Mesh workers and explorer fallback.
 */

import type { FileSystemTreeEntry } from "@/shared/file-system";
import type { CommandExecutor, FileSystemTreeOptions } from "./command-executor";
import { joinExecutionPath } from "./execution-path";
import { DomainError } from "../domain/domain-error";

const DIRECTORY_CONCURRENCY = 8;

export async function walkDirectoryTree(
  executor: CommandExecutor,
  rootDirectory: string,
  options: FileSystemTreeOptions & { maxResultBytes?: number },
): Promise<FileSystemTreeEntry[]> {
  const deferredNames = new Set(options.deferredDirectoryNames);
  const result: FileSystemTreeEntry[] = [];
  const pendingDirectories = [""];
  let resultBytes = 2;

  while (pendingDirectories.length > 0) {
    options.signal?.throwIfAborted();
    const directories = pendingDirectories.splice(0, DIRECTORY_CONCURRENCY);
    const listings = await Promise.allSettled(directories.map(async (directory) => ({
      directory,
      entries: await executor.listDirectoryEntries(
        joinExecutionPath(executor.pathStyle, rootDirectory, directory),
        { includeHidden: options.includeHidden, signal: options.signal },
      ),
    })));
    options.signal?.throwIfAborted();
    for (const listing of listings) {
      if (listing.status === "rejected") {
        throw listing.reason;
      }
      const { directory, entries } = listing.value;
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        const path = joinExecutionPath(executor.pathStyle, directory, entry.name);
        const node: FileSystemTreeEntry = {
          path,
          kind: entry.kind,
          isSymbolicLink: entry.isSymbolicLink,
        };
        if (options.maxResultBytes !== undefined) {
          resultBytes += Buffer.byteLength(JSON.stringify(node), "utf8")
            + (result.length > 0 ? 1 : 0);
          if (resultBytes > options.maxResultBytes) {
            throw new DomainError(
              "directory_tree_size_limit_exceeded",
              "The directory tree exceeds the aggregate size limit.",
              { details: { maxResultBytes: options.maxResultBytes } },
            );
          }
        }
        result.push(node);
        if (
          entry.kind === "directory"
          && !entry.isSymbolicLink
          && !deferredNames.has(entry.name)
        ) {
          pendingDirectories.push(path);
        }
      }
    }
  }
  return result;
}
