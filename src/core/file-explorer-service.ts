/**
 * Generic file explorer service for executor-backed roots.
 */

import { posix as pathPosix } from "node:path";
import type {
  WorkspaceFileEntry,
} from "../types";
import type { CommandExecutor } from "./command-executor";

const LIST_SEPARATOR = "\t";

export interface FileExplorerTarget {
  id: string;
  rootDirectory: string;
  pathScopeLabel: string;
  executor: CommandExecutor;
}

export interface FileExplorerListResult {
  directory: string;
  entries: WorkspaceFileEntry[];
}

export interface FileExplorerTreeResult {
  entriesByDirectory: Record<string, WorkspaceFileEntry[]>;
}

export interface FileExplorerReadResult {
  file: WorkspaceFileEntry;
  content: string;
}

export interface FileExplorerWriteResult {
  success: true;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export class FileExplorerConflictError extends Error {
  readonly currentFile: WorkspaceFileEntry | null;

  constructor(message: string, currentFile: WorkspaceFileEntry | null) {
    super(message);
    this.name = "FileExplorerConflictError";
    this.currentFile = currentFile;
  }
}

function normalizeRootDirectory(directory: string): string {
  const normalized = pathPosix.normalize(directory.trim());
  return normalized === "." ? "/" : normalized.replace(/\/+$/, "") || "/";
}

export async function resolveFileExplorerRootDirectory(
  executor: CommandExecutor,
  defaultRootDirectory: string,
  requestedStartDirectory?: string,
): Promise<string> {
  const normalizedDefaultRootDirectory = normalizeRootDirectory(defaultRootDirectory);
  const trimmedStartDirectory = requestedStartDirectory?.trim();
  if (!trimmedStartDirectory) {
    return normalizedDefaultRootDirectory;
  }

  const normalizedRootDirectory = normalizeRootDirectory(trimmedStartDirectory);
  if (normalizedRootDirectory === normalizedDefaultRootDirectory) {
    return normalizedRootDirectory;
  }

  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "if [ -d \"$1\" ]; then printf 'directory'; elif [ -e \"$1\" ]; then printf 'file'; else printf 'missing'; fi",
      "file-explorer-root-type",
      normalizedRootDirectory,
    ],
    {
      logFailures: false,
    },
  );
  if (!result.success) {
    throw new Error(result.stderr.trim() || "Failed to resolve start directory");
  }

  const pathType = result.stdout.trim();
  if (pathType === "directory") {
    return normalizedRootDirectory;
  }
  if (pathType === "file") {
    throw new Error("Requested start directory is not a directory");
  }
  throw new Error("Requested start directory does not exist");
}

function toRelativePath(rootDirectory: string, absolutePath: string): string {
  const root = normalizeRootDirectory(rootDirectory);
  const normalizedPath = pathPosix.normalize(absolutePath);
  const relativePath = pathPosix.relative(root, normalizedPath);
  return relativePath === "." ? "" : relativePath;
}

function resolveTargetPath(target: FileExplorerTarget, requestedPath: string): string {
  const root = normalizeRootDirectory(target.rootDirectory);
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath || trimmedPath === ".") {
    return root;
  }

  const normalizedPath = trimmedPath.startsWith("/")
    ? pathPosix.normalize(trimmedPath)
    : pathPosix.normalize(pathPosix.join(root, trimmedPath));
  const relativePath = pathPosix.relative(root, normalizedPath);

  if (relativePath && (relativePath.startsWith("..") || pathPosix.isAbsolute(relativePath))) {
    throw new Error(`Requested path must stay within the ${target.pathScopeLabel} directory`);
  }

  return normalizedPath;
}

function parseModifiedAt(timestampSeconds: string): string {
  const timestamp = Number.parseFloat(timestampSeconds);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid file timestamp: ${timestampSeconds}`);
  }
  return new Date(timestamp * 1000).toISOString();
}

function buildVersionToken(timestampSeconds: string, size: number, contentHash?: string): string {
  return contentHash
    ? `${timestampSeconds}:${size}:${contentHash}`
    : `${timestampSeconds}:${size}`;
}

async function runMetadataCommand(
  executor: CommandExecutor,
  absolutePath: string,
): Promise<{ kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string } | null> {
  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "if [ ! -e \"$1\" ]; then exit 2; fi; if [ -d \"$1\" ]; then typeFlag=d; hash=-; else typeFlag=f; if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum \"$1\" | cut -d' ' -f1); elif command -v shasum >/dev/null 2>&1; then hash=$(shasum -a 256 \"$1\" | cut -d' ' -f1); else hash=; fi; fi; if stat --version >/dev/null 2>&1; then size=$(stat -c '%s' \"$1\"); modified=$(stat -c '%Y' \"$1\"); else size=$(stat -f '%z' \"$1\"); modified=$(stat -f '%m' \"$1\"); fi; printf '%s\\t%s\\t%s\\t%s\\n' \"$typeFlag\" \"$size\" \"$modified\" \"$hash\"",
      "file-explorer-metadata",
      absolutePath,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    if (result.exitCode === 2) {
      return null;
    }
    throw new Error(result.stderr.trim() || "Failed to read file metadata");
  }

  const [typeFlag, sizeText, timestampSeconds, contentHash] = result.stdout.trim().split(LIST_SEPARATOR);
  if (!typeFlag || !sizeText || !timestampSeconds) {
    throw new Error("Failed to parse file metadata");
  }

  const size = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(size)) {
    throw new Error(`Invalid metadata size: ${sizeText}`);
  }

  return {
    kind: typeFlag === "d" ? "directory" : "file",
    size,
    modifiedAt: parseModifiedAt(timestampSeconds),
    versionToken: buildVersionToken(
      timestampSeconds,
      size,
      typeFlag === "f" && contentHash && contentHash !== "-" ? contentHash : undefined,
    ),
  };
}

async function runMetadataBatchCommand(
  executor: CommandExecutor,
  absolutePaths: string[],
): Promise<Array<{ kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string } | null>> {
  if (absolutePaths.length === 0) {
    return [];
  }

  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "for path in \"$@\"; do if [ ! -e \"$path\" ]; then printf 'missing\\n'; continue; fi; if [ -d \"$path\" ]; then typeFlag=d; hash=-; else typeFlag=f; if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum \"$path\" | cut -d' ' -f1); elif command -v shasum >/dev/null 2>&1; then hash=$(shasum -a 256 \"$path\" | cut -d' ' -f1); else hash=; fi; fi; if stat --version >/dev/null 2>&1; then size=$(stat -c '%s' \"$path\"); modified=$(stat -c '%Y' \"$path\"); else size=$(stat -f '%z' \"$path\"); modified=$(stat -f '%m' \"$path\"); fi; printf '%s\\t%s\\t%s\\t%s\\n' \"$typeFlag\" \"$size\" \"$modified\" \"$hash\"; done",
      "file-explorer-batch-metadata",
      ...absolutePaths,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    throw new Error(result.stderr.trim() || "Failed to read file metadata");
  }

  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  if (lines.length !== absolutePaths.length) {
    throw new Error("Failed to parse file metadata");
  }

  return lines.map((line) => {
    if (line === "missing") {
      return null;
    }
    const [typeFlag, sizeText, timestampSeconds, contentHash] = line.split(LIST_SEPARATOR);
    if (!typeFlag || !sizeText || !timestampSeconds) {
      throw new Error("Failed to parse file metadata");
    }

    const size = Number.parseInt(sizeText, 10);
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid metadata size: ${sizeText}`);
    }

    return {
      kind: typeFlag === "d" ? "directory" : "file",
      size,
      modifiedAt: parseModifiedAt(timestampSeconds),
      versionToken: buildVersionToken(
        timestampSeconds,
        size,
        typeFlag === "f" && contentHash && contentHash !== "-" ? contentHash : undefined,
      ),
    };
  });
}

function toFileEntry(
  target: FileExplorerTarget,
  absolutePath: string,
  metadata: { kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string },
): WorkspaceFileEntry {
  return {
    name: pathPosix.basename(absolutePath),
    path: toRelativePath(target.rootDirectory, absolutePath),
    kind: metadata.kind,
    size: metadata.size,
    modifiedAt: metadata.modifiedAt,
    versionToken: metadata.versionToken,
  };
}

function sortEntries(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function toEntriesByDirectory(entries: WorkspaceFileEntry[]): Record<string, WorkspaceFileEntry[]> {
  const entriesByDirectory: Record<string, WorkspaceFileEntry[]> = {
    "": [],
  };

  for (const entry of entries) {
    const parentDirectory = pathPosix.dirname(entry.path);
    const directoryKey = parentDirectory === "." ? "" : parentDirectory;
    entriesByDirectory[directoryKey] ??= [];
    entriesByDirectory[directoryKey].push(entry);
    if (entry.kind === "directory" && !entriesByDirectory[entry.path]) {
      entriesByDirectory[entry.path] = [];
    }
  }

  for (const [directory, directoryEntries] of Object.entries(entriesByDirectory)) {
    entriesByDirectory[directory] = sortEntries(directoryEntries);
  }

  return entriesByDirectory;
}

async function runFullTreeCommand(
  target: FileExplorerTarget,
): Promise<WorkspaceFileEntry[]> {
  const result = await target.executor.exec(
    "bash",
    [
      "-lc",
      `root="$1"; if [ ! -d "$root" ]; then exit 2; fi; emit_paths() { if command -v tree >/dev/null 2>&1; then tree -afi --noreport "$root"; else find "$root" -mindepth 1 -print; fi; }; while IFS= read -r path; do if [ -z "$path" ] || [ "$path" = "$root" ]; then continue; fi; if [ -d "$path" ]; then typeFlag=d; else typeFlag=f; fi; if stat --version >/dev/null 2>&1; then size=$(stat -c '%s' "$path"); modified=$(stat -c '%Y' "$path"); else size=$(stat -f '%z' "$path"); modified=$(stat -f '%m' "$path"); fi; printf '%s\\t%s\\t%s\\t%s\\n' "$path" "$typeFlag" "$size" "$modified"; done < <(emit_paths)`,
      "file-explorer-tree",
      target.rootDirectory,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    if (result.exitCode === 2) {
      throw new Error("Requested path does not exist");
    }
    throw new Error(result.stderr.trim() || "Failed to load file tree");
  }

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [absolutePath, typeFlag, sizeText, timestampSeconds] = line.split(LIST_SEPARATOR);
      if (!absolutePath || !typeFlag || !sizeText || !timestampSeconds) {
        throw new Error("Failed to parse file tree");
      }

      const size = Number.parseInt(sizeText, 10);
      if (!Number.isFinite(size)) {
        throw new Error(`Invalid metadata size: ${sizeText}`);
      }

      return toFileEntry(target, absolutePath, {
        kind: typeFlag === "d" ? "directory" : "file",
        size,
        modifiedAt: parseModifiedAt(timestampSeconds),
        versionToken: buildVersionToken(timestampSeconds, size),
      });
    });
}

export class FileExplorerService {
  async listDirectory(
    target: FileExplorerTarget,
    requestedPath = "",
    options?: { includeHidden?: boolean },
  ): Promise<FileExplorerListResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const metadata = await runMetadataCommand(target.executor, absolutePath);

    if (!metadata) {
      throw new Error("Requested path does not exist");
    }
    if (metadata.kind !== "directory") {
      throw new Error("Requested path is not a directory");
    }

    const includeHidden = options?.includeHidden ?? true;
    const names = await target.executor.listDirectory(absolutePath, {
      includeHidden,
    });
    const entryPaths = names.map((name) => pathPosix.join(absolutePath, name));
    const metadataEntries = await runMetadataBatchCommand(target.executor, entryPaths);
    const entries = metadataEntries
      .map((entryMetadata, index) => {
        if (!entryMetadata) {
          return null;
        }

        return toFileEntry(target, entryPaths[index]!, entryMetadata);
      })
      .filter((entry): entry is WorkspaceFileEntry => entry !== null);

    return {
      directory: toRelativePath(target.rootDirectory, absolutePath),
      entries: sortEntries(entries),
    };
  }

  async loadTree(
    target: FileExplorerTarget,
  ): Promise<FileExplorerTreeResult> {
    const entries = await runFullTreeCommand(target);
    return {
      entriesByDirectory: toEntriesByDirectory(entries),
    };
  }

  async readFile(target: FileExplorerTarget, requestedPath: string): Promise<FileExplorerReadResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const metadata = await runMetadataCommand(target.executor, absolutePath);

    if (!metadata) {
      throw new Error("Requested file does not exist");
    }
    if (metadata.kind !== "file") {
      throw new Error("Requested path is not a file");
    }

    const content = await target.executor.readFile(absolutePath);
    if (content === null) {
      throw new Error("Requested file does not exist");
    }

    return {
      file: toFileEntry(target, absolutePath, metadata),
      content,
    };
  }

  async getMetadata(target: FileExplorerTarget, requestedPath: string): Promise<WorkspaceFileEntry | null> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const metadata = await runMetadataCommand(target.executor, absolutePath);
    return metadata ? toFileEntry(target, absolutePath, metadata) : null;
  }

  async writeFile(
    target: FileExplorerTarget,
    requestedPath: string,
    content: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
    },
  ): Promise<FileExplorerWriteResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const currentFile = await this.getMetadata(target, requestedPath);

    if (currentFile && currentFile.kind !== "file") {
      throw new Error("Requested path is not a file");
    }

    if (
      !options?.overwrite
      && (currentFile?.versionToken ?? null) !== (options?.expectedVersionToken ?? null)
    ) {
      throw new FileExplorerConflictError("File changed outside the editor", currentFile);
    }

    const wroteFile = await target.executor.writeFile(absolutePath, content);
    if (!wroteFile) {
      throw new Error("Failed to write file");
    }

    const updatedFile = await this.getMetadata(target, requestedPath);
    if (!updatedFile) {
      throw new Error("File was written but metadata could not be read");
    }

    return {
      success: true,
      file: updatedFile,
      overwritten: Boolean(options?.overwrite && currentFile),
    };
  }
}

export const fileExplorerService = new FileExplorerService();
