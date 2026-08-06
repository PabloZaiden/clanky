/**
 * Generic file explorer service for executor-backed roots.
 */

import { posix as pathPosix } from "node:path";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WorkspaceFileKind, WorkspaceFileEntry, WorkspaceFileNode } from "@/shared";
import type { CommandExecutor } from "./command-executor";
import {
  FileExplorerConflictError,
  FileExplorerError,
  fileExplorerOperationError,
} from "./file-explorer-errors";
import { getBrowserImageMimeType } from "../utils/workspace-file-images";
import { createLogger } from "@pablozaiden/webapp/server";

export { FileExplorerConflictError } from "./file-explorer-errors";

const log = createLogger("core:file-explorer-service");
const LIST_SEPARATOR = "\t";
const FULL_TREE_FIELD_SEPARATOR = "\0";
const FULL_TREE_RECORD_SEPARATOR = "\0\0";
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

const FULL_TREE_CAPABILITY_SCRIPT = [
  "root=\"$1\"; if [ ! -d \"$root\" ]; then exit 2; fi;",
  "if ! command -v find >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then exit 3; fi;",
  "if ! find \"$root\" -prune -exec true {} + >/dev/null 2>&1; then exit 3; fi;",
  "if stat -c '%f' \"$root\" >/dev/null 2>&1; then printf 'gnu';",
  "else bsdMode=$(stat -f '%p' \"$root\" 2>/dev/null) || bsdMode=;",
  "case \"$bsdMode\" in [0-7][0-7][0-7][0-7][0-7]|[0-7][0-7][0-7][0-7][0-7][0-7]) printf 'bsd';; *) exit 3;; esac; fi",
].join(" ");
const FULL_TREE_EMIT_SCRIPT =
  "source=\"$1\"; statFlag=\"$2\"; statFormat=\"$3\"; followFlag=\"$4\"; shift 4; for path do if [ \"$followFlag\" = \"1\" ]; then mode=$(stat -L \"$statFlag\" \"$statFormat\" \"$path\" 2>/dev/null); else mode=$(stat \"$statFlag\" \"$statFormat\" \"$path\" 2>/dev/null); fi; if [ -z \"$mode\" ]; then printf \"error\\0%s\\0stat_failed\\0\\0\" \"$path\"; else printf \"%s\\0%s\\0%s\\0\\0\" \"$source\" \"$path\" \"$mode\"; fi; done";

type FullTreeStatFormat = {
  family: "gnu" | "bsd";
  flag: "-c" | "-f";
  format: "%f" | "%p";
  modeBase: 8 | 16;
};

const FULL_TREE_STAT_FORMATS: Record<FullTreeStatFormat["family"], FullTreeStatFormat> = {
  gnu: {
    family: "gnu",
    flag: "-c",
    format: "%f",
    modeBase: 16,
  },
  bsd: {
    family: "bsd",
    flag: "-f",
    format: "%p",
    modeBase: 8,
  },
};

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

export interface FileExplorerImageReadResult {
  file: WorkspaceFileEntry;
  contentType: string;
  data: Uint8Array;
}

export interface FileExplorerDownloadReadResult {
  file: WorkspaceFileEntry;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

export interface FileExplorerDownloadMetadataResult {
  file: WorkspaceFileEntry;
  contentType: string;
}

export interface FileExplorerWriteResult {
  success: true;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface FileExplorerRenameResult {
  success: true;
  file: WorkspaceFileEntry;
  previousPath: string;
  overwritten: boolean;
}

export interface FileExplorerDeleteResult {
  success: true;
  deletedPath: string;
  kind: WorkspaceFileKind;
}

export interface FileExplorerUploadSessionResult {
  uploadId: string;
  path: string;
  directory: string;
  fileName: string;
  size: number;
}

export interface FileExplorerUploadChunkResult {
  success: true;
  uploadId: string;
  bytesWritten: number;
  nextOffset: number;
}

export interface FileExplorerUploadCompleteResult {
  success: true;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface FileExplorerUploadCancelResult {
  success: true;
  uploadId: string;
}

interface FileExplorerUploadSession {
  id: string;
  targetId: string;
  rootDirectory: string;
  directory: string;
  fileName: string;
  relativePath: string;
  finalAbsolutePath: string;
  tempAbsolutePath: string;
  size: number;
  overwrite: boolean;
  bytesWritten: number;
  createdAt: number;
  lastTouchedAt: number;
}

const UPLOAD_TEMP_DIRECTORY_NAME = ".clanky-upload-tmp";
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_UPLOAD_SESSIONS = 100;
const uploadSessions = new Map<string, FileExplorerUploadSession>();

function commandFailure(
  result: { stderr: string },
  fallbackMessage: string,
): FileExplorerError<"operation_failed"> {
  const stderr = result.stderr.trim();
  return fileExplorerOperationError(
    fallbackMessage,
    stderr ? new Error(stderr) : undefined,
  );
}

interface FileExplorerMetadataOptions {
  includeContentHash?: boolean;
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
    throw commandFailure(result, "Failed to resolve start directory");
  }

  const pathType = result.stdout.trim();
  if (pathType === "directory") {
    return normalizedRootDirectory;
  }
  if (pathType === "file") {
    throw new FileExplorerError(
      "invalid_start_directory_type",
      "Requested start directory is not a directory",
    );
  }
  throw new FileExplorerError(
    "start_directory_not_found",
    "Requested start directory does not exist",
  );
}

function toRelativePath(rootDirectory: string, absolutePath: string): string {
  const root = normalizeRootDirectory(rootDirectory);
  const normalizedPath = pathPosix.normalize(absolutePath);
  const relativePath = pathPosix.relative(root, normalizedPath);
  return relativePath === "." ? "" : relativePath;
}

function assertOverwriteKindCompatible(
  existingFile: WorkspaceFileEntry | null,
  replacementKind: WorkspaceFileKind,
): void {
  if (!existingFile) {
    return;
  }
  if (existingFile.kind === "directory") {
    throw new FileExplorerConflictError("Destination already exists as a directory", existingFile);
  }
  if (existingFile.kind !== replacementKind) {
    throw new FileExplorerConflictError("Destination already exists with a different type", existingFile);
  }
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
    throw new FileExplorerError(
      "path_outside_root",
      `Requested path must stay within the ${target.pathScopeLabel} directory`,
      {
        details: {
          pathScopeLabel: target.pathScopeLabel,
        },
      },
    );
  }

  return normalizedPath;
}

function resolveUploadTempDirectory(target: FileExplorerTarget): string {
  return resolveTargetPath(target, UPLOAD_TEMP_DIRECTORY_NAME);
}

function assertSafeBaseName(name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new FileExplorerError("invalid_file_name", "File name is required");
  }
  if (
    trimmedName === "."
    || trimmedName === ".."
    || trimmedName.includes("/")
    || trimmedName.includes("\\")
    || trimmedName.includes("\0")
  ) {
    throw new FileExplorerError(
      "invalid_file_name",
      "File name must not contain path separators",
    );
  }
  return trimmedName;
}

function assertMutablePath(requestedPath: string): void {
  if (!requestedPath.trim() || requestedPath.trim() === ".") {
    throw new FileExplorerError(
      "root_not_mutable",
      "Cannot modify the active explorer root",
    );
  }
}

function assertSameUploadTarget(target: FileExplorerTarget, session: FileExplorerUploadSession): void {
  if (session.targetId !== target.id || session.rootDirectory !== normalizeRootDirectory(target.rootDirectory)) {
    throw new FileExplorerError(
      "upload_session_target_mismatch",
      "Upload session does not belong to the active explorer target",
    );
  }
}

function parseModifiedAt(timestampSeconds: string): string {
  const timestamp = Number.parseFloat(timestampSeconds);
  if (!Number.isFinite(timestamp)) {
    throw fileExplorerOperationError("Invalid file timestamp");
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
  options?: FileExplorerMetadataOptions,
): Promise<{ kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string } | null> {
  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "if [ ! -e \"$1\" ]; then exit 2; fi; includeHash=\"${2:-1}\"; if [ -d \"$1\" ]; then typeFlag=d; hash=-; else typeFlag=f; if [ \"$includeHash\" = \"1\" ]; then if command -v sha256sum >/dev/null 2>&1; then hash=$(sha256sum \"$1\" | cut -d' ' -f1); elif command -v shasum >/dev/null 2>&1; then hash=$(shasum -a 256 \"$1\" | cut -d' ' -f1); else hash=; fi; else hash=-; fi; fi; if stat --version >/dev/null 2>&1; then size=$(stat -c '%s' \"$1\"); modified=$(stat -c '%Y' \"$1\"); else size=$(stat -f '%z' \"$1\"); modified=$(stat -f '%m' \"$1\"); fi; printf '%s\\t%s\\t%s\\t%s\\n' \"$typeFlag\" \"$size\" \"$modified\" \"$hash\"",
      "file-explorer-metadata",
      absolutePath,
      options?.includeContentHash === false ? "0" : "1",
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    if (result.exitCode === 2) {
      return null;
    }
    throw commandFailure(result, "Failed to read file metadata");
  }

  const [typeFlag, sizeText, timestampSeconds, contentHash] = result.stdout.trim().split(LIST_SEPARATOR);
  if (!typeFlag || !sizeText || !timestampSeconds) {
    throw fileExplorerOperationError("Failed to parse file metadata");
  }

  const size = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(size)) {
    throw fileExplorerOperationError("Invalid metadata size");
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
    throw commandFailure(result, "Failed to inspect path");
  }

  const output = result.stdout.trim();
  if (output === "d") {
    return "directory";
  }
  if (output === "f") {
    return "file";
  }
  throw fileExplorerOperationError("Failed to parse path inspection result");
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
    throw commandFailure(result, "Failed to inspect directory entries");
  }

  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  if (lines.length !== absolutePaths.length) {
    throw fileExplorerOperationError("Failed to parse directory entries");
  }

  return lines.map((line) => {
    if (line === "missing") {
      return null;
    }
    if (line !== "d" && line !== "f") {
      throw fileExplorerOperationError("Failed to parse directory entries");
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
  const mimeType = metadata.kind === "file" ? getBrowserImageMimeType(absolutePath) : null;
  return {
    ...toFileNode(target, absolutePath, metadata.kind),
    absolutePath,
    size: metadata.size,
    modifiedAt: metadata.modifiedAt,
    versionToken: metadata.versionToken,
    ...(mimeType ? { mimeType, isImage: true } : {}),
  };
}

async function getFileEntry(
  target: FileExplorerTarget,
  requestedPath: string,
  options?: FileExplorerMetadataOptions,
): Promise<WorkspaceFileEntry | null> {
  const absolutePath = resolveTargetPath(target, requestedPath);
  const metadata = await runMetadataCommand(target.executor, absolutePath, options);
  return metadata ? toFileEntry(target, absolutePath, metadata) : null;
}

function assertDownloadableFile(file: WorkspaceFileEntry | null): WorkspaceFileEntry {
  if (!file) {
    throw new FileExplorerError("file_not_found", "Requested file does not exist");
  }
  if (file.kind !== "file") {
    throw new FileExplorerError("invalid_path_type", "Requested path is not a file");
  }
  return file;
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

function parseModeText(modeText: string, base: 8 | 16): number | null {
  const pattern = base === 8 ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/;
  if (!pattern.test(modeText)) {
    return null;
  }

  const mode = Number.parseInt(modeText, base);
  return Number.isSafeInteger(mode) ? mode : null;
}

function parseModeKind(
  modeText: string,
  base: 8 | 16,
): "directory" | "file" | "symlink" | null {
  const mode = parseModeText(modeText, base);
  if (mode === null) {
    return null;
  }

  const fileType = base === 8 ? mode & 0o170000 : mode & 0xf000;
  if (fileType === (base === 8 ? 0o040000 : 0x4000)) {
    return "directory";
  }
  if (fileType === (base === 8 ? 0o120000 : 0xa000)) {
    return "symlink";
  }
  return "file";
}

interface FullTreeParsedEntry {
  source: "base" | "link";
  absolutePath: string;
  kind: "directory" | "file" | "symlink";
}

interface FullTreeParseResult {
  entries: FullTreeParsedEntry[];
  skippedRecordReasons: Record<string, number>;
}

function isFullTreePathWithinRoot(rootDirectory: string, absolutePath: string): boolean {
  if (!pathPosix.isAbsolute(absolutePath)) {
    return false;
  }

  const root = normalizeRootDirectory(rootDirectory);
  const relativePath = pathPosix.relative(root, pathPosix.normalize(absolutePath));
  return relativePath === ""
    || (!relativePath.startsWith("..") && !pathPosix.isAbsolute(relativePath));
}

function parseFullTreeOutput(
  stdout: string,
  rootDirectory: string,
  statFormat: FullTreeStatFormat,
): FullTreeParseResult {
  if (!stdout) {
    return {
      entries: [],
      skippedRecordReasons: {},
    };
  }
  if (!stdout.endsWith(FULL_TREE_RECORD_SEPARATOR)) {
    throw fileExplorerOperationError("Failed to parse file tree: incomplete record");
  }

  const payload = stdout.slice(0, -FULL_TREE_RECORD_SEPARATOR.length);
  if (!payload) {
    return {
      entries: [],
      skippedRecordReasons: {},
    };
  }

  const entries: FullTreeParsedEntry[] = [];
  const skippedRecordReasons = new Map<string, number>();
  const skipRecord = (reason: string): void => {
    skippedRecordReasons.set(reason, (skippedRecordReasons.get(reason) ?? 0) + 1);
  };

  for (const record of payload.split(FULL_TREE_RECORD_SEPARATOR)) {
    const fields = record.split(FULL_TREE_FIELD_SEPARATOR);
    if (fields.length !== 3) {
      skipRecord("invalid_field_count");
      continue;
    }

    const source = fields[0];
    const absolutePath = fields[1];
    const value = fields[2];
    if (!source || !absolutePath || !value) {
      skipRecord("empty_field");
      continue;
    }
    if (source === "error") {
      skipRecord("remote_entry_error");
      continue;
    }
    if (source !== "base" && source !== "link") {
      skipRecord("invalid_source");
      continue;
    }
    if (!isFullTreePathWithinRoot(rootDirectory, absolutePath)) {
      skipRecord("path_outside_root");
      continue;
    }

    const kind = parseModeKind(value, statFormat.modeBase);
    if (!kind) {
      skipRecord("invalid_mode");
      continue;
    }

    entries.push({
      source,
      absolutePath,
      kind,
    });
  }

  return {
    entries,
    skippedRecordReasons: Object.fromEntries(skippedRecordReasons),
  };
}

async function detectFullTreeStatFormat(
  executor: CommandExecutor,
  rootDirectory: string,
): Promise<FullTreeStatFormat> {
  const result = await executor.exec(
    "bash",
    [
      "-lc",
      FULL_TREE_CAPABILITY_SCRIPT,
      "file-explorer-tree-capabilities",
      rootDirectory,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    if (result.exitCode === 2) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    throw fileExplorerOperationError(
      "Workspace host does not support structured file-tree discovery",
      result.stderr || `Capability probe exited with code ${result.exitCode}`,
    );
  }

  const family = result.stdout.trim();
  if (family !== "gnu" && family !== "bsd") {
    throw fileExplorerOperationError("Failed to parse file-tree capability result");
  }
  return FULL_TREE_STAT_FORMATS[family];
}

function buildFullTreeCommand(): string {
  const baseFindCommand =
    `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune -exec sh -c '${FULL_TREE_EMIT_SCRIPT}' file-explorer-tree-entry "base" "$statFlag" "$statFormat" "0" {} + \\) -o -exec sh -c '${FULL_TREE_EMIT_SCRIPT}' file-explorer-tree-entry "base" "$statFlag" "$statFormat" "0" {} +`;
  const linkFindCommand =
    `find "$root" ! -path "$root" \\( -type d \\( ${FULL_TREE_DEFERRED_FIND_PATTERN} \\) -prune \\) -o -type l -exec sh -c '${FULL_TREE_EMIT_SCRIPT}' file-explorer-tree-link "link" "$statFlag" "$statFormat" "1" {} +`;
  return `root="$1"; statFlag="$2"; statFormat="$3"; if [ ! -d "$root" ]; then exit 2; fi; ${baseFindCommand}; ${linkFindCommand}`;
}

async function runFullTreeCommand(
  target: FileExplorerTarget,
): Promise<WorkspaceFileNode[]> {
  const statFormat = await detectFullTreeStatFormat(target.executor, target.rootDirectory);
  const result = await target.executor.exec(
    "bash",
    [
      "-lc",
      buildFullTreeCommand(),
      "file-explorer-tree",
      target.rootDirectory,
      statFormat.flag,
      statFormat.format,
    ],
    {
      logFailures: false,
    },
  );

  if (!result.success) {
    if (result.exitCode === 2) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    throw commandFailure(result, "Failed to load file tree");
  }

  const parsedOutput = parseFullTreeOutput(result.stdout, target.rootDirectory, statFormat);
  if (Object.keys(parsedOutput.skippedRecordReasons).length > 0) {
    log.warn("Skipped invalid file-tree records", {
      reasons: parsedOutput.skippedRecordReasons,
    });
  }

  const parsedEntries = parsedOutput.entries.reduce<{
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

async function readFileBytes(
  target: FileExplorerTarget,
  absolutePath: string,
): Promise<Uint8Array> {
  const result = await target.executor.exec("bash", [
    "-lc",
    `path="$1"; if base64 --help 2>&1 | grep -q -- '-w'; then base64 -w 0 "$path"; else base64 < "$path" | tr -d '\\n'; fi`,
    "file-explorer-file-bytes",
    absolutePath,
  ], {
    logFailures: false,
    timeout: 30 * 60 * 1000,
  });
  if (!result.success) {
    throw commandFailure(result, "Failed to read file");
  }

  return Uint8Array.from(Buffer.from(result.stdout, "base64"));
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
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (pathKind !== "directory") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a directory");
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
      throw new FileExplorerError("file_not_found", "Requested file does not exist");
    }
    if (metadata.kind !== "file") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a file");
    }

    const content = await target.executor.readFile(absolutePath);
    if (content === null) {
      throw new FileExplorerError("file_not_found", "Requested file does not exist");
    }

    return {
      file: toFileEntry(target, absolutePath, metadata),
      content,
    };
  }

  async readImageFile(target: FileExplorerTarget, requestedPath: string): Promise<FileExplorerImageReadResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const metadata = await runMetadataCommand(target.executor, absolutePath);

    if (!metadata) {
      throw new FileExplorerError("file_not_found", "Requested file does not exist");
    }
    if (metadata.kind !== "file") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a file");
    }

    const file = toFileEntry(target, absolutePath, metadata);
    if (!file.isImage || !file.mimeType) {
      throw new FileExplorerError(
        "invalid_preview_type",
        "Requested file is not a browser-renderable image",
      );
    }

    return {
      file,
      contentType: file.mimeType,
      data: await readFileBytes(target, absolutePath),
    };
  }

  async readDownloadFile(
    target: FileExplorerTarget,
    requestedPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<FileExplorerDownloadReadResult> {
    const { file, contentType } = await this.getDownloadMetadata(target, requestedPath);
    const stream = await target.executor.streamFile(file.absolutePath, {
      signal: options?.signal,
    });
    if (!stream) {
      throw new FileExplorerError("file_not_found", "Requested file does not exist");
    }

    return {
      file,
      contentType,
      stream,
    };
  }

  async getDownloadMetadata(
    target: FileExplorerTarget,
    requestedPath: string,
  ): Promise<FileExplorerDownloadMetadataResult> {
    const file = assertDownloadableFile(await getFileEntry(target, requestedPath, {
      includeContentHash: false,
    }));
    return {
      file,
      contentType: file.mimeType ?? "application/octet-stream",
    };
  }

  async getMetadata(target: FileExplorerTarget, requestedPath: string): Promise<WorkspaceFileEntry | null> {
    return await getFileEntry(target, requestedPath);
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
      throw new FileExplorerError("invalid_path_type", "Requested path is not a file");
    }

    if (
      !options?.overwrite
      && (currentFile?.versionToken ?? null) !== (options?.expectedVersionToken ?? null)
    ) {
      throw new FileExplorerConflictError("File changed outside the code explorer", currentFile);
    }

    const wroteFile = await target.executor.writeFile(absolutePath, content);
    if (!wroteFile) {
      throw fileExplorerOperationError("Failed to write file");
    }

    const updatedFile = await this.getMetadata(target, requestedPath);
    if (!updatedFile) {
      throw fileExplorerOperationError("File was written but metadata could not be read");
    }

    return {
      success: true,
      file: updatedFile,
      overwritten: Boolean(options?.overwrite && currentFile),
    };
  }

  async renameNode(
    target: FileExplorerTarget,
    requestedPath: string,
    newName: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
    },
  ): Promise<FileExplorerRenameResult> {
    assertMutablePath(requestedPath);
    const safeName = assertSafeBaseName(newName);
    const sourceAbsolutePath = resolveTargetPath(target, requestedPath);
    const sourceFile = await this.getMetadata(target, requestedPath);
    if (!sourceFile) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (
      sourceFile.kind === "file"
      && options?.expectedVersionToken !== undefined
      && sourceFile.versionToken !== options.expectedVersionToken
    ) {
      throw new FileExplorerConflictError("File changed outside the code explorer", sourceFile);
    }

    const destinationAbsolutePath = resolveTargetPath(
      target,
      pathPosix.join(pathPosix.dirname(sourceFile.path), safeName),
    );
    if (sourceAbsolutePath === destinationAbsolutePath) {
      return {
        success: true,
        file: sourceFile,
        previousPath: sourceFile.path,
        overwritten: false,
      };
    }

    const existingDestination = await runMetadataCommand(target.executor, destinationAbsolutePath, {
      includeContentHash: false,
    });
    const existingDestinationFile = existingDestination
      ? toFileEntry(target, destinationAbsolutePath, existingDestination)
      : null;
    if (existingDestinationFile && !options?.overwrite) {
      throw new FileExplorerConflictError("Destination already exists", existingDestinationFile);
    }
    if (options?.overwrite) {
      assertOverwriteKindCompatible(existingDestinationFile, sourceFile.kind);
    }

    const result = await target.executor.exec("bash", [
      "-lc",
      "src=\"$1\"; dest=\"$2\"; kind=\"$3\"; overwrite=\"$4\"; if [ ! -e \"$src\" ]; then exit 2; fi; if [ -e \"$dest\" ]; then if [ \"$overwrite\" != \"1\" ]; then exit 3; fi; if [ -d \"$dest\" ]; then exit 4; fi; if [ \"$kind\" = \"directory\" ] && [ ! -d \"$dest\" ]; then exit 4; fi; if [ \"$kind\" = \"file\" ] && [ ! -f \"$dest\" ]; then exit 4; fi; fi; mv -- \"$src\" \"$dest\"",
      "file-explorer-rename",
      sourceAbsolutePath,
      destinationAbsolutePath,
      sourceFile.kind,
      options?.overwrite ? "1" : "0",
    ], {
      logFailures: false,
    });
    if (!result.success) {
      if (result.exitCode === 2) {
        throw new FileExplorerError("file_not_found", "Requested path does not exist");
      }
      if (result.exitCode === 3) {
        throw new FileExplorerConflictError("Destination already exists", null);
      }
      if (result.exitCode === 4) {
        throw new FileExplorerConflictError("Destination already exists with an incompatible type", null);
      }
      throw commandFailure(result, "Failed to rename file");
    }

    const updatedFile = await this.getMetadata(target, toRelativePath(target.rootDirectory, destinationAbsolutePath));
    if (!updatedFile) {
      throw fileExplorerOperationError("File was renamed but metadata could not be read");
    }

    return {
      success: true,
      file: updatedFile,
      previousPath: sourceFile.path,
      overwritten: Boolean(existingDestinationFile && options?.overwrite),
    };
  }

  async deleteNode(
    target: FileExplorerTarget,
    requestedPath: string,
    options?: {
      expectedVersionToken?: string | null;
      kind?: WorkspaceFileKind;
    },
  ): Promise<FileExplorerDeleteResult> {
    assertMutablePath(requestedPath);
    const absolutePath = resolveTargetPath(target, requestedPath);
    const file = await this.getMetadata(target, requestedPath);
    if (!file) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (options?.kind && file.kind !== options.kind) {
      throw new FileExplorerError("invalid_path_type", `Requested path is not a ${options.kind}`);
    }
    if (
      file.kind === "file"
      && options?.expectedVersionToken !== undefined
      && file.versionToken !== options.expectedVersionToken
    ) {
      throw new FileExplorerConflictError("File changed outside the code explorer", file);
    }

    const result = await target.executor.exec("bash", [
      "-lc",
      "path=\"$1\"; kind=\"$2\"; if [ ! -e \"$path\" ]; then exit 2; fi; if [ \"$kind\" = \"directory\" ]; then if [ ! -d \"$path\" ]; then exit 4; fi; rm -rf -- \"$path\"; else if [ ! -f \"$path\" ]; then exit 4; fi; rm -f -- \"$path\"; fi",
      "file-explorer-delete",
      absolutePath,
      file.kind,
    ], {
      logFailures: false,
    });
    if (!result.success) {
      if (result.exitCode === 2) {
        throw new FileExplorerError("file_not_found", "Requested path does not exist");
      }
      if (result.exitCode === 4) {
        throw new FileExplorerError("invalid_path_type", "Requested path type changed before delete");
      }
      throw commandFailure(result, "Failed to delete file");
    }

    return {
      success: true,
      deletedPath: file.path,
      kind: file.kind,
    };
  }

  async createUploadSession(
    target: FileExplorerTarget,
    directory: string,
    fileName: string,
    size: number,
    options?: {
      overwrite?: boolean;
    },
  ): Promise<FileExplorerUploadSessionResult> {
    await this.cleanupExpiredUploadSessions(target);
    await this.cleanupAbandonedUploadTempFiles(target);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new FileExplorerError("invalid_upload_state", "Invalid upload size");
    }
    const activeSessionsForTarget = Array.from(uploadSessions.values()).filter(
      (session) => session.targetId === target.id && session.rootDirectory === normalizeRootDirectory(target.rootDirectory),
    ).length;
    if (activeSessionsForTarget >= MAX_UPLOAD_SESSIONS) {
      throw fileExplorerOperationError("Too many active upload sessions");
    }

    const safeName = assertSafeBaseName(fileName);
    const normalizedDirectory = directory.trim();
    const directoryAbsolutePath = resolveTargetPath(target, normalizedDirectory);
    const directoryKind = await runNodeTypeCommand(target.executor, directoryAbsolutePath);
    if (!directoryKind) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (directoryKind !== "directory") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a directory");
    }

    const finalAbsolutePath = resolveTargetPath(target, pathPosix.join(normalizedDirectory, safeName));
    const relativePath = toRelativePath(target.rootDirectory, finalAbsolutePath);
    const existingFile = await runMetadataCommand(target.executor, finalAbsolutePath, {
      includeContentHash: false,
    });
    const existingFinalFile = existingFile ? toFileEntry(target, finalAbsolutePath, existingFile) : null;
    if (existingFinalFile && !options?.overwrite) {
      throw new FileExplorerConflictError("Destination already exists", existingFinalFile);
    }
    if (options?.overwrite) {
      assertOverwriteKindCompatible(existingFinalFile, "file");
    }

    const uploadId = randomUUID();
    const now = Date.now();
    const tempAbsolutePath = pathPosix.join(
      resolveUploadTempDirectory(target),
      `${uploadId}-${safeName}`,
    );
    const session: FileExplorerUploadSession = {
      id: uploadId,
      targetId: target.id,
      rootDirectory: normalizeRootDirectory(target.rootDirectory),
      directory: toRelativePath(target.rootDirectory, directoryAbsolutePath),
      fileName: safeName,
      relativePath,
      finalAbsolutePath,
      tempAbsolutePath,
      size,
      overwrite: Boolean(options?.overwrite),
      bytesWritten: 0,
      createdAt: now,
      lastTouchedAt: now,
    };
    uploadSessions.set(uploadId, session);

    return {
      uploadId,
      path: relativePath,
      directory: session.directory,
      fileName: safeName,
      size,
    };
  }

  async writeUploadChunk(
    target: FileExplorerTarget,
    uploadId: string,
    offset: number,
    stream: ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<FileExplorerUploadChunkResult> {
    const session = await this.getActiveUploadSession(target, uploadId);
    if (offset !== session.bytesWritten) {
      throw new FileExplorerError(
        "invalid_upload_state",
        `Expected upload offset ${session.bytesWritten}, received ${offset}`,
      );
    }

    if (!target.executor.writeFileStream) {
      throw fileExplorerOperationError("Workspace host does not support streamed file uploads");
    }
    const result = await target.executor.writeFileStream(session.tempAbsolutePath, stream, {
      append: true,
      expectedOffset: offset,
      signal: options?.signal,
    });
    if (!result.success) {
      throw new FileExplorerError(
        "invalid_upload_state",
        result.error ?? "Failed to write upload chunk",
      );
    }
    session.bytesWritten += result.bytesWritten;
    session.lastTouchedAt = Date.now();

    return {
      success: true,
      uploadId,
      bytesWritten: result.bytesWritten,
      nextOffset: session.bytesWritten,
    };
  }

  async completeUpload(
    target: FileExplorerTarget,
    uploadId: string,
  ): Promise<FileExplorerUploadCompleteResult> {
    const session = await this.getActiveUploadSession(target, uploadId);
    if (session.bytesWritten !== session.size) {
      throw new FileExplorerError(
        "invalid_upload_state",
        `Upload is incomplete: expected ${session.size} bytes, received ${session.bytesWritten}`,
      );
    }

    const existingFinalFile = await runMetadataCommand(target.executor, session.finalAbsolutePath, {
      includeContentHash: false,
    });
    const existingFinalEntry = existingFinalFile ? toFileEntry(target, session.finalAbsolutePath, existingFinalFile) : null;
    if (existingFinalEntry && !session.overwrite) {
      throw new FileExplorerConflictError("Destination already exists", existingFinalEntry);
    }
    if (session.overwrite) {
      assertOverwriteKindCompatible(existingFinalEntry, "file");
    }

    const result = await target.executor.exec("bash", [
      "-lc",
      "tmp=\"$1\"; dest=\"$2\"; overwrite=\"$3\"; if [ ! -f \"$tmp\" ]; then exit 2; fi; if [ -e \"$dest\" ]; then if [ \"$overwrite\" != \"1\" ]; then exit 3; fi; if [ ! -f \"$dest\" ]; then exit 4; fi; fi; mv -- \"$tmp\" \"$dest\"",
      "file-explorer-upload-complete",
      session.tempAbsolutePath,
      session.finalAbsolutePath,
      session.overwrite ? "1" : "0",
    ], {
      logFailures: false,
    });
    if (!result.success) {
      if (result.exitCode === 2) {
        throw new FileExplorerError(
          "upload_session_not_found",
          "Upload temporary file does not exist",
        );
      }
      if (result.exitCode === 3) {
        throw new FileExplorerConflictError("Destination already exists", null);
      }
      if (result.exitCode === 4) {
        throw new FileExplorerConflictError("Destination already exists with an incompatible type", null);
      }
      throw commandFailure(result, "Failed to complete upload");
    }

    const uploadedFile = await this.getMetadata(target, session.relativePath);
    uploadSessions.delete(uploadId);
    await this.cleanupUploadTempDirectory(target, session);
    if (!uploadedFile) {
      throw fileExplorerOperationError("Upload completed but metadata could not be read");
    }

    return {
      success: true,
      file: uploadedFile,
      overwritten: Boolean(existingFinalEntry && session.overwrite),
    };
  }

  async cancelUpload(
    target: FileExplorerTarget,
    uploadId: string,
  ): Promise<FileExplorerUploadCancelResult> {
    const session = await this.getActiveUploadSession(target, uploadId);
    uploadSessions.delete(uploadId);
    await target.executor.exec("bash", [
      "-lc",
      "rm -f -- \"$1\"",
      "file-explorer-upload-cancel",
      session.tempAbsolutePath,
    ], {
      logFailures: false,
    });
    await this.cleanupUploadTempDirectory(target, session);
    return {
      success: true,
      uploadId,
    };
  }

  private async getActiveUploadSession(
    target: FileExplorerTarget,
    uploadId: string,
  ): Promise<FileExplorerUploadSession> {
    await this.cleanupExpiredUploadSessions(target);
    const session = uploadSessions.get(uploadId);
    if (!session) {
      throw new FileExplorerError(
        "upload_session_not_found",
        "Upload session does not exist",
      );
    }
    assertSameUploadTarget(target, session);
    if (Date.now() - session.lastTouchedAt > UPLOAD_SESSION_TTL_MS) {
      uploadSessions.delete(uploadId);
      await this.deleteUploadTempFile(target, session);
      await this.cleanupUploadTempDirectory(target, session);
      throw new FileExplorerError(
        "upload_session_not_found",
        "Upload session does not exist",
      );
    }
    return session;
  }

  private async cleanupExpiredUploadSessions(target: FileExplorerTarget): Promise<void> {
    const now = Date.now();
    const normalizedRootDirectory = normalizeRootDirectory(target.rootDirectory);
    const expiredSessions = Array.from(uploadSessions.values()).filter((session) => {
      return session.targetId === target.id
        && session.rootDirectory === normalizedRootDirectory
        && now - session.lastTouchedAt > UPLOAD_SESSION_TTL_MS;
    });
    for (const session of expiredSessions) {
      uploadSessions.delete(session.id);
      await this.deleteUploadTempFile(target, session);
      await this.cleanupUploadTempDirectory(target, session);
    }
  }

  private async cleanupAbandonedUploadTempFiles(target: FileExplorerTarget): Promise<void> {
    const tempDirectory = resolveUploadTempDirectory(target);
    const ttlMinutes = String(Math.max(1, Math.floor(UPLOAD_SESSION_TTL_MS / 60_000)));
    await target.executor.exec("bash", [
      "-lc",
      "dir=\"$1\"; ttl_minutes=\"$2\"; if [ -d \"$dir\" ]; then find \"$dir\" -type f -mmin +\"$ttl_minutes\" -delete; rmdir -- \"$dir\" 2>/dev/null || true; fi",
      "file-explorer-upload-cleanup-abandoned",
      tempDirectory,
      ttlMinutes,
    ], {
      logFailures: false,
    });
  }

  private async deleteUploadTempFile(
    target: FileExplorerTarget,
    session: FileExplorerUploadSession,
  ): Promise<void> {
    await target.executor.exec("bash", [
      "-lc",
      "rm -f -- \"$1\"",
      "file-explorer-upload-delete-temp",
      session.tempAbsolutePath,
    ], {
      logFailures: false,
    });
  }

  private async cleanupUploadTempDirectory(
    target: FileExplorerTarget,
    session: FileExplorerUploadSession,
  ): Promise<void> {
    await target.executor.exec("bash", [
      "-lc",
      "tmp=\"$1\"; dir=$(dirname -- \"$tmp\"); rmdir -- \"$dir\" 2>/dev/null || true",
      "file-explorer-upload-cleanup",
      session.tempAbsolutePath,
    ], {
      logFailures: false,
    });
  }
}

export const fileExplorerService = new FileExplorerService();
