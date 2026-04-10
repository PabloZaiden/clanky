/**
 * Generic file explorer service for executor-backed roots.
 */

import { posix as pathPosix } from "node:path";
import type {
  WorkspaceFileEntry,
  WorkspaceFileNode,
} from "../types";
import type { CommandExecutor } from "./command-executor";

const LIST_SEPARATOR = "\t";
const FULL_TREE_DEFERRED_DIRECTORY_NAMES = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
  "obj",
  "bin",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".terraform",
  ".dart_tool",
  ".pub-cache",
  ".nuget",
  "Pods",
] as const;
const FULL_TREE_DEFERRED_DIRECTORY_NAME_SET = new Set<string>(FULL_TREE_DEFERRED_DIRECTORY_NAMES);
const FULL_TREE_DEFERRED_FIND_PATTERN = FULL_TREE_DEFERRED_DIRECTORY_NAMES
  .map((name) => `-name '${name}'`)
  .join(" -o ");

export interface FileExplorerTarget {
  id: string;
  rootDirectory: string;
  pathScopeLabel: string;
  executor: CommandExecutor;
}

export interface FileExplorerListResult {
  directory: string;
  entries: WorkspaceFileNode[];
}

export interface FileExplorerTreeResult {
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
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

async function runNodeTypeCommand(
  executor: CommandExecutor,
  absolutePath: string,
): Promise<"file" | "directory" | null> {
  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "if [ ! -e \"$1\" ]; then exit 2; fi; if [ -d \"$1\" ]; then printf 'd'; else printf 'f'; fi",
      "file-explorer-node-type",
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
    throw new Error(result.stderr.trim() || "Failed to inspect path");
  }

  const output = result.stdout.trim();
  if (output === "d") {
    return "directory";
  }
  if (output === "f") {
    return "file";
  }
  throw new Error("Failed to parse path inspection result");
}

async function runNodeBatchCommand(
  executor: CommandExecutor,
  absolutePaths: string[],
): Promise<Array<{ kind: "file" | "directory" } | null>> {
  if (absolutePaths.length === 0) {
    return [];
  }

  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "for path in \"$@\"; do if [ ! -e \"$path\" ]; then printf 'missing\\n'; continue; fi; if [ -d \"$path\" ]; then printf 'd\\n'; else printf 'f\\n'; fi; done",
      "file-explorer-batch-nodes",
      ...absolutePaths,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    throw new Error(result.stderr.trim() || "Failed to inspect directory entries");
  }

  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  if (lines.length !== absolutePaths.length) {
    throw new Error("Failed to parse directory entries");
  }

  return lines.map((line) => {
    if (line === "missing") {
      return null;
    }
    if (line !== "d" && line !== "f") {
      throw new Error("Failed to parse directory entries");
    }

    return {
      kind: line === "d" ? "directory" : "file",
    };
  });
}

function isDeferredFullTreeDirectory(absolutePath: string): boolean {
  return FULL_TREE_DEFERRED_DIRECTORY_NAME_SET.has(pathPosix.basename(absolutePath));
}

function toFileNode(
  target: FileExplorerTarget,
  absolutePath: string,
  kind: "file" | "directory",
  options?: { loadOnExpand?: boolean },
): WorkspaceFileNode {
  return {
    name: pathPosix.basename(absolutePath),
    path: toRelativePath(target.rootDirectory, absolutePath),
    kind,
    ...(options?.loadOnExpand ? { loadOnExpand: true } : {}),
  };
}

function toFileEntry(
  target: FileExplorerTarget,
  absolutePath: string,
  metadata: { kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string },
): WorkspaceFileEntry {
  return {
    ...toFileNode(target, absolutePath, metadata.kind),
    size: metadata.size,
    modifiedAt: metadata.modifiedAt,
    versionToken: metadata.versionToken,
  };
}

function sortEntries<T extends WorkspaceFileNode>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function toEntriesByDirectory(entries: WorkspaceFileNode[]): Record<string, WorkspaceFileNode[]> {
  const entriesByDirectory: Record<string, WorkspaceFileNode[]> = {
    "": [],
  };

  for (const entry of entries) {
    const parentDirectory = pathPosix.dirname(entry.path);
    const directoryKey = parentDirectory === "." ? "" : parentDirectory;
    entriesByDirectory[directoryKey] ??= [];
    entriesByDirectory[directoryKey].push(entry);
    if (entry.kind === "directory" && !entry.loadOnExpand && !entriesByDirectory[entry.path]) {
      entriesByDirectory[entry.path] = [];
    }
  }

  for (const [directory, directoryEntries] of Object.entries(entriesByDirectory)) {
    entriesByDirectory[directory] = sortEntries(directoryEntries);
  }

  return entriesByDirectory;
}

function normalizeFullTreeLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseModeText(modeText: string): { mode: number; base: 8 | 16 } {
  if (/^[0-7]+$/.test(modeText)) {
    return {
      mode: Number.parseInt(modeText, 8),
      base: 8,
    };
  }
  if (/^[0-9a-fA-F]+$/.test(modeText)) {
    return {
      mode: Number.parseInt(modeText, 16),
      base: 16,
    };
  }
  throw new Error(`Invalid file mode: ${modeText}`);
}

function parseModeKind(modeText: string): "directory" | "file" | "symlink" {
  const { mode, base } = parseModeText(modeText);
  const fileType = base === 8 ? mode & 0o170000 : mode & 0xf000;
  if (fileType === (base === 8 ? 0o040000 : 0x4000)) {
    return "directory";
  }
  if (fileType === (base === 8 ? 0o120000 : 0xa000)) {
    return "symlink";
  }
  return "file";
}

function parseFullTreeLine(line: string): {
  source: "base" | "link";
  absolutePath: string;
  kind: "directory" | "file" | "symlink";
} {
  const normalizedLine = normalizeFullTreeLine(line);
  if (!normalizedLine) {
    throw new Error("Failed to parse file tree");
  }

  const firstSeparatorIndex = normalizedLine.indexOf(LIST_SEPARATOR);
  const lastSeparatorIndex = normalizedLine.lastIndexOf(LIST_SEPARATOR);
  if (
    firstSeparatorIndex <= 0
    || lastSeparatorIndex <= firstSeparatorIndex
    || lastSeparatorIndex === normalizedLine.length - 1
  ) {
    throw new Error("Failed to parse file tree");
  }

  const source = normalizedLine.slice(0, firstSeparatorIndex);
  if (source !== "base" && source !== "link") {
    throw new Error("Failed to parse file tree");
  }

  const absolutePath = normalizedLine.slice(firstSeparatorIndex + LIST_SEPARATOR.length, lastSeparatorIndex);
  const modeText = normalizedLine.slice(lastSeparatorIndex + LIST_SEPARATOR.length).trim();
  if (!absolutePath) {
    throw new Error("Failed to parse file tree");
  }
  if (!modeText) {
    throw new Error("Failed to parse file tree");
  }

  return {
    source,
    absolutePath,
    kind: parseModeKind(modeText),
  };
}

async function runFullTreeCommand(
  target: FileExplorerTarget,
): Promise<WorkspaceFileNode[]> {
  const gnuFindCommand = `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune -exec stat -c $'base\\t%n\\t%f\\n' {} + \\) -o -exec stat -c $'base\\t%n\\t%f\\n' {} +`;
  const gnuLinkFindCommand = `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune \\) -o -type l -exec stat -Lc $'link\\t%n\\t%f\\n' {} +`;
  const bsdFindCommand = `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune -exec stat -f $'base\\t%N\\t%p\\n' {} + \\) -o -exec stat -f $'base\\t%N\\t%p\\n' {} +`;
  const bsdLinkFindCommand = `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune \\) -o -type l -exec stat -Lf $'link\\t%N\\t%p\\n' {} +`;
  const result = await target.executor.exec(
    "bash",
    [
      "-lc",
      `root="$1"; if [ ! -d "$root" ]; then exit 2; fi; if stat --version >/dev/null 2>&1; then ${gnuFindCommand}; ${gnuLinkFindCommand} 2>/dev/null || true; else ${bsdFindCommand}; ${bsdLinkFindCommand} 2>/dev/null || true; fi`,
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

  const parsedEntries = result.stdout
    .trimEnd()
    .split("\n")
    .filter((line) => normalizeFullTreeLine(line).length > 0)
    .map((line) => parseFullTreeLine(line))
    .reduce<{
      baseEntries: Array<{ absolutePath: string; kind: "directory" | "file" | "symlink" }>;
      linkKinds: Map<string, "directory" | "file">;
    }>((accumulator, entry) => {
      if (entry.source === "link") {
        accumulator.linkKinds.set(entry.absolutePath, entry.kind === "directory" ? "directory" : "file");
        return accumulator;
      }

      accumulator.baseEntries.push({
        absolutePath: entry.absolutePath,
        kind: entry.kind,
      });
      return accumulator;
    }, {
      baseEntries: [],
      linkKinds: new Map<string, "directory" | "file">(),
    });

  return parsedEntries.baseEntries
    .map((entry) => toFileNode(
      target,
      entry.absolutePath,
      entry.kind === "symlink" ? parsedEntries.linkKinds.get(entry.absolutePath) ?? "file" : entry.kind,
      {
        loadOnExpand: entry.kind === "directory" && isDeferredFullTreeDirectory(entry.absolutePath),
      },
    ))
    .filter((entry) => entry.path.length > 0);
}

export class FileExplorerService {
  async listDirectory(
    target: FileExplorerTarget,
    requestedPath = "",
    options?: { includeHidden?: boolean },
  ): Promise<FileExplorerListResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const pathKind = await runNodeTypeCommand(target.executor, absolutePath);

    if (!pathKind) {
      throw new Error("Requested path does not exist");
    }
    if (pathKind !== "directory") {
      throw new Error("Requested path is not a directory");
    }

    const includeHidden = options?.includeHidden ?? true;
    const names = await target.executor.listDirectory(absolutePath, {
      includeHidden,
    });
    const entryPaths = names.map((name) => pathPosix.join(absolutePath, name));
    const nodeEntries = await runNodeBatchCommand(target.executor, entryPaths);
    const entries = nodeEntries
      .map((entryMetadata, index) => {
        if (!entryMetadata) {
          return null;
        }

        return toFileNode(target, entryPaths[index]!, entryMetadata.kind);
      })
      .filter((entry): entry is WorkspaceFileNode => entry !== null);

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
      throw new FileExplorerConflictError("File changed outside the code explorer", currentFile);
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
