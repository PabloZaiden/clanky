/**
 * Native filesystem operations for the local execution host.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  truncate,
} from "node:fs/promises";
import {
  dirnameExecutionPath,
  executionPathStyleForPlatform,
  joinExecutionPath,
  type ExecutionPathStyle,
} from "../execution-path";
import type {
  FileDeleteOptions,
  FileMoveOptions,
  FileMoveResult,
  FileStreamOptions,
  FileSystemDirectoryEntry,
  FileSystemMetadata,
  FileWriteStreamOptions,
  FileWriteStreamResult,
} from "../command-executor";

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

class FileSizeLimitError extends Error {}

export class LocalFileSystem {
  readonly pathStyle: ExecutionPathStyle;

  constructor(platform: string = process.platform) {
    const pathStyle = executionPathStyleForPlatform(platform);
    if (!pathStyle) {
      throw new Error(`Unsupported local filesystem platform: ${platform}`);
    }
    this.pathStyle = pathStyle;
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async readFile(
    path: string,
    options?: FileStreamOptions,
  ): Promise<string | null> {
    if (options?.signal?.aborted || !(await this.fileExists(path))) {
      return null;
    }
    try {
      const content = await Bun.file(path).text();
      return options?.signal?.aborted ? null : content;
    } catch {
      return null;
    }
  }

  async streamFile(
    path: string,
    options?: FileStreamOptions,
  ): Promise<ReadableStream<Uint8Array> | null> {
    if (options?.signal?.aborted || !(await this.fileExists(path))) {
      return null;
    }
    const file = Bun.file(path);
    return options?.range
      ? file.slice(options.range.start, options.range.end + 1).stream()
      : file.stream();
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    try {
      if (options?.signal?.aborted) {
        return { success: false, bytesWritten: 0, error: "Write aborted" };
      }

      await mkdir(dirnameExecutionPath(path, this.pathStyle), { recursive: true });
      const expectedOffset = options?.expectedOffset;
      if (expectedOffset !== undefined) {
        let currentSize = 0;
        try {
          currentSize = (await stat(path)).size;
        } catch (error) {
          if (!isMissingFileError(error)) {
            throw error;
          }
        }
        if (options?.append && currentSize > expectedOffset) {
          await truncate(path, expectedOffset);
          currentSize = expectedOffset;
        }
        if (currentSize !== expectedOffset) {
          return {
            success: false,
            bytesWritten: 0,
            error: `Expected file offset ${expectedOffset}, found ${currentSize}`,
          };
        }
      }

      const writeStream = createWriteStream(path, {
        flags: options?.append && expectedOffset !== 0 ? "r+" : "w",
        ...(options?.append ? { start: expectedOffset ?? 0 } : {}),
      });
      let bytesWritten = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          if (options?.maxBytes !== undefined && bytesWritten + chunk.byteLength > options.maxBytes) {
            callback(new FileSizeLimitError("Upload stream exceeds the maximum accepted size"));
          } else {
            bytesWritten += chunk.byteLength;
            callback(null, chunk);
          }
        },
      });
      try {
        await pipeline(Readable.from(stream), counter, writeStream, { signal: options?.signal });
      } catch (error) {
        if (error instanceof FileSizeLimitError) {
          return { success: false, bytesWritten, error: error.message, errorCode: "size_limit" };
        }
        return { success: false, bytesWritten, error: String(error) };
      }
      return { success: true, bytesWritten };
    } catch (error) {
      return { success: false, bytesWritten: 0, error: String(error) };
    }
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    try {
      await mkdir(
        dirnameExecutionPath(destinationPath, this.pathStyle),
        { recursive: true },
      );
      await copyFile(sourcePath, destinationPath);
      return true;
    } catch {
      return false;
    }
  }

  async listDirectory(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<string[]> {
    const entries = await readdir(path);
    return options?.includeHidden
      ? entries
      : entries.filter((entry) => !entry.startsWith("."));
  }

  async getFileMetadata(
    path: string,
    options?: { includeContentHash?: boolean },
  ): Promise<FileSystemMetadata | null> {
    let linkStats;
    try {
      linkStats = await lstat(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }

    const isSymbolicLink = linkStats.isSymbolicLink();
    let fileStats = linkStats;
    if (isSymbolicLink) {
      try {
        fileStats = await stat(path);
      } catch (error) {
        if (isMissingFileError(error)) {
          return {
            kind: "file",
            size: linkStats.size,
            modifiedAtMs: linkStats.mtimeMs,
            isSymbolicLink: true,
          };
        }
        throw error;
      }
    }
    const kind = fileStats.isDirectory() ? "directory" : "file";
    return {
      kind,
      size: fileStats.size,
      modifiedAtMs: fileStats.mtimeMs,
      ...(kind === "file" && options?.includeContentHash !== false
        ? { contentHash: await hashFile(path) }
        : {}),
      isSymbolicLink,
    };
  }

  async listDirectoryEntries(
    path: string,
    options?: { includeHidden?: boolean },
  ): Promise<FileSystemDirectoryEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    const visibleEntries = options?.includeHidden
      ? entries
      : entries.filter((entry) => !entry.name.startsWith("."));
    return await Promise.all(visibleEntries.map(async (entry) => {
      if (!entry.isSymbolicLink()) {
        return {
          name: entry.name,
          kind: entry.isDirectory() ? "directory" as const : "file" as const,
          isSymbolicLink: false,
        };
      }
      try {
        const target = await stat(joinExecutionPath(
          this.pathStyle,
          path,
          entry.name,
        ));
        return {
          name: entry.name,
          kind: target.isDirectory() ? "directory" as const : "file" as const,
          isSymbolicLink: true,
        };
      } catch {
        return {
          name: entry.name,
          kind: "file" as const,
          isSymbolicLink: true,
        };
      }
    }));
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    try {
      await mkdir(dirnameExecutionPath(path, this.pathStyle), { recursive: true });
      await Bun.write(path, content);
      return true;
    } catch {
      return false;
    }
  }

  async movePath(
    sourcePath: string,
    destinationPath: string,
    options?: FileMoveOptions,
  ): Promise<FileMoveResult> {
    try {
      const source = await this.getFileMetadata(sourcePath, {
        includeContentHash: false,
      });
      if (!source) {
        return { success: false, errorCode: "source_not_found" };
      }
      const destination = await this.getFileMetadata(destinationPath, {
        includeContentHash: false,
      });
      if (destination && !options?.overwrite) {
        return { success: false, errorCode: "destination_exists" };
      }
      if (destination) {
        if (
          source.kind !== destination.kind
          || source.kind === "directory"
        ) {
          return { success: false, errorCode: "incompatible_type" };
        }
      }
      const destinationParent = await this.getFileMetadata(
        dirnameExecutionPath(destinationPath, this.pathStyle),
        { includeContentHash: false },
      );
      if (destinationParent && destinationParent.kind !== "directory") {
        return {
          success: false,
          errorCode: "invalid_destination_parent",
        };
      }
      await mkdir(
        dirnameExecutionPath(destinationPath, this.pathStyle),
        { recursive: true },
      );
      // Node uses replace-existing rename semantics for files on every supported
      // platform, including MoveFileExW on Windows; pre-deleting would break the
      // atomic replacement used by completed uploads.
      await rename(sourcePath, destinationPath);
      return { success: true };
    } catch (error) {
      const source = await this.getFileMetadata(sourcePath, {
        includeContentHash: false,
      }).catch(() => null);
      if (!source) {
        return { success: false, errorCode: "source_not_found" };
      }
      const destination = await this.getFileMetadata(destinationPath, {
        includeContentHash: false,
      }).catch(() => null);
      if (destination && !options?.overwrite) {
        return { success: false, errorCode: "destination_exists" };
      }
      if (
        destination
        && (
          source.kind !== destination.kind
          || source.kind === "directory"
        )
      ) {
        return { success: false, errorCode: "incompatible_type" };
      }
      const destinationParent = await this.getFileMetadata(
        dirnameExecutionPath(destinationPath, this.pathStyle),
        { includeContentHash: false },
      ).catch(() => null);
      if (destinationParent && destinationParent.kind !== "directory") {
        return {
          success: false,
          errorCode: "invalid_destination_parent",
        };
      }
      return {
        success: false,
        errorCode: "operation_failed",
        error: String(error),
      };
    }
  }

  async deletePath(path: string, options: FileDeleteOptions): Promise<boolean> {
    try {
      const metadata = await this.getFileMetadata(path, {
        includeContentHash: false,
      });
      if (!metadata || metadata.kind !== options.kind) {
        return false;
      }
      if (metadata.kind === "directory" && !metadata.isSymbolicLink) {
        if (options.recursive) {
          await rm(path, { recursive: true, force: false });
        } else {
          await rmdir(path);
        }
      } else {
        await rm(path, { force: false });
      }
      return true;
    } catch {
      return false;
    }
  }
}
