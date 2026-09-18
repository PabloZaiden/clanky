/**
 * Generic file explorer service for executor-backed roots.
 */

import { posix as pathPosix } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceFileKind, WorkspaceFileEntry, WorkspaceFileNode } from "@/shared";
import type {
  CommandExecutor,
  FileMoveResult,
  FileSystemMetadata,
} from "./command-executor";
import {
  FileExplorerConflictError,
  FileExplorerError,
  fileExplorerOperationError,
} from "./file-explorer-errors";
import {
  detectBrowserImageMimeType,
  getBrowserImageMimeType,
} from "../utils/workspace-file-images";
import {
  basenameExecutionPath,
  executionPathsEqual,
  joinExecutionPath,
  normalizeExecutionPath,
  normalizeExecutionRoot,
  relativeExecutionPath,
  resolveExecutionPathUnscoped,
  type ExecutionPathStyle,
} from "./execution-path";

export { FileExplorerConflictError } from "./file-explorer-errors";

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
const FULL_TREE_DIRECTORY_CONCURRENCY = 8;

export interface FileExplorerTarget {
  id: string;
  /** Default navigation directory; it is not a filesystem access boundary. */
  rootDirectory: string;
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

interface FileExplorerMetadataOptions {
  includeContentHash?: boolean;
}

function normalizeRootDirectory(
  directory: string,
  pathStyle: ExecutionPathStyle,
): string {
  return normalizeExecutionRoot(directory, pathStyle);
}

export async function resolveFileExplorerRootDirectory(
  executor: CommandExecutor,
  defaultRootDirectory: string,
  requestedStartDirectory?: string,
): Promise<string> {
  const normalizedDefaultRootDirectory = normalizeRootDirectory(
    defaultRootDirectory,
    executor.pathStyle,
  );
  const trimmedStartDirectory = requestedStartDirectory?.trim();
  if (!trimmedStartDirectory) {
    return normalizedDefaultRootDirectory;
  }

  const normalizedRootDirectory = resolveExecutionPathUnscoped(
    normalizedDefaultRootDirectory,
    trimmedStartDirectory,
    executor.pathStyle,
  );
  if (normalizedRootDirectory === normalizedDefaultRootDirectory) {
    return normalizedRootDirectory;
  }

  const metadata = await executor.getFileMetadata(normalizedRootDirectory, {
    includeContentHash: false,
  });
  if (metadata?.kind === "directory") {
    return normalizedRootDirectory;
  }
  if (metadata?.kind === "file") {
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

function toRelativePath(
  rootDirectory: string,
  absolutePath: string,
  pathStyle: ExecutionPathStyle,
): string {
  const root = normalizeRootDirectory(rootDirectory, pathStyle);
  const normalizedPath = normalizeExecutionPath(absolutePath, pathStyle);
  const relativePath = relativeExecutionPath(root, normalizedPath, pathStyle);
  return relativePath === "." ? "" : relativePath.replaceAll("\\", "/");
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

async function throwMoveFailure(
  target: FileExplorerTarget,
  destinationAbsolutePath: string,
  result: Extract<FileMoveResult, { success: false }>,
  sourceMissingCode: "file_not_found" | "invalid_upload_state",
  operationMessage: string,
): Promise<never> {
  switch (result.errorCode) {
    case "source_not_found":
      throw new FileExplorerError(
        sourceMissingCode,
        sourceMissingCode === "file_not_found"
          ? "Requested path does not exist"
          : "The upload temporary file no longer exists",
      );
    case "destination_exists":
    case "incompatible_type": {
      const destination = await getFileMetadata(
        target.executor,
        destinationAbsolutePath,
        { includeContentHash: false },
      );
      throw new FileExplorerConflictError(
        result.errorCode === "destination_exists"
          ? "Destination already exists"
          : "Destination exists with an incompatible type",
        destination
          ? toFileEntry(target, destinationAbsolutePath, destination)
          : null,
      );
    }
    case "invalid_destination_parent":
      throw new FileExplorerError(
        "invalid_path_type",
        "Destination parent is not a directory",
      );
    case "operation_failed":
      throw fileExplorerOperationError(
        operationMessage,
        result.error ? new Error(result.error) : undefined,
      );
  }
}

function resolveTargetPath(target: FileExplorerTarget, requestedPath: string): string {
  const root = normalizeRootDirectory(
    target.rootDirectory,
    target.executor.pathStyle,
  );
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath || trimmedPath === ".") {
    return root;
  }
  if (trimmedPath.includes("\0")) {
    throw new FileExplorerError(
      "invalid_path",
      "Requested path contains an invalid NUL byte",
    );
  }

  try {
    return resolveExecutionPathUnscoped(
      root,
      trimmedPath,
      target.executor.pathStyle,
    );
  } catch (error) {
    throw new FileExplorerError(
      "invalid_path",
      "Requested path is invalid for the execution host",
      { cause: error },
    );
  }
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
  if (
    session.targetId !== target.id
    || !executionPathsEqual(
      session.rootDirectory,
      normalizeRootDirectory(
        target.rootDirectory,
        target.executor.pathStyle,
      ),
      target.executor.pathStyle,
    )
  ) {
    throw new FileExplorerError(
      "upload_session_target_mismatch",
      "Upload session does not belong to the active explorer target",
    );
  }
}

function buildVersionToken(
  modifiedAtMs: number,
  size: number,
  contentHash?: string,
): string {
  return contentHash
    ? `${String(modifiedAtMs)}:${String(size)}:${contentHash}`
    : `${String(modifiedAtMs)}:${String(size)}`;
}

async function getFileMetadata(
  executor: CommandExecutor,
  absolutePath: string,
  options?: FileExplorerMetadataOptions,
): Promise<FileSystemMetadata | null> {
  return await executor.getFileMetadata(absolutePath, {
    includeContentHash: options?.includeContentHash,
  });
}

function isDeferredFullTreeDirectory(
  absolutePath: string,
  pathStyle: ExecutionPathStyle,
): boolean {
  return FULL_TREE_DEFERRED_DIRECTORY_NAME_SET.has(
    basenameExecutionPath(absolutePath, pathStyle),
  );
}

function toFileNode(
  target: FileExplorerTarget,
  absolutePath: string,
  kind: "file" | "directory",
  options?: { loadOnExpand?: boolean },
): WorkspaceFileNode {
  return {
    name: basenameExecutionPath(absolutePath, target.executor.pathStyle),
    path: toRelativePath(
      target.rootDirectory,
      absolutePath,
      target.executor.pathStyle,
    ),
    kind,
    ...(options?.loadOnExpand ? { loadOnExpand: true } : {}),
  };
}

function toFileEntry(
  target: FileExplorerTarget,
  absolutePath: string,
  metadata: FileSystemMetadata,
): WorkspaceFileEntry {
  const mimeType = metadata.kind === "file" ? getBrowserImageMimeType(absolutePath) : null;
  return {
    ...toFileNode(target, absolutePath, metadata.kind),
    absolutePath,
    size: metadata.size,
    modifiedAt: new Date(metadata.modifiedAtMs).toISOString(),
    versionToken: buildVersionToken(
      metadata.modifiedAtMs,
      metadata.size,
      metadata.contentHash,
    ),
    ...(mimeType ? { mimeType, isImage: true } : {}),
  };
}

async function getFileEntry(
  target: FileExplorerTarget,
  requestedPath: string,
  options?: FileExplorerMetadataOptions,
): Promise<WorkspaceFileEntry | null> {
  const absolutePath = resolveTargetPath(target, requestedPath);
  const metadata = await getFileMetadata(target.executor, absolutePath, options);
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

async function loadFullTree(
  target: FileExplorerTarget,
): Promise<WorkspaceFileNode[]> {
  const rootMetadata = await getFileMetadata(
    target.executor,
    target.rootDirectory,
    { includeContentHash: false },
  );
  if (!rootMetadata) {
    throw new FileExplorerError(
      "file_not_found",
      "Requested path does not exist",
    );
  }
  if (rootMetadata.kind !== "directory") {
    throw new FileExplorerError(
      "invalid_path_type",
      "Requested path is not a directory",
    );
  }

  const result: WorkspaceFileNode[] = [];
  const pendingDirectories = [target.rootDirectory];
  while (pendingDirectories.length > 0) {
    const directories = pendingDirectories.splice(
      0,
      FULL_TREE_DIRECTORY_CONCURRENCY,
    );
    const directoryEntries = await Promise.all(directories.map(
      async (directory) => ({
        directory,
        entries: await target.executor.listDirectoryEntries(directory, {
          includeHidden: true,
        }),
      }),
    ));
    for (const { directory, entries } of directoryEntries) {
      for (const entry of entries) {
        const absolutePath = joinExecutionPath(
          target.executor.pathStyle,
          directory,
          entry.name,
        );
        const deferred = entry.kind === "directory"
          && isDeferredFullTreeDirectory(
            absolutePath,
            target.executor.pathStyle,
          );
        result.push(toFileNode(target, absolutePath, entry.kind, {
          loadOnExpand: deferred,
        }));
        if (
          entry.kind === "directory"
          && !entry.isSymbolicLink
          && !deferred
        ) {
          pendingDirectories.push(absolutePath);
        }
      }
    }
  }
  return result;
}

async function readFileBytes(
  target: FileExplorerTarget,
  absolutePath: string,
): Promise<Uint8Array> {
  const stream = await target.executor.streamFile(absolutePath);
  if (!stream) {
    throw new FileExplorerError(
      "file_not_found",
      "Requested file does not exist",
    );
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class FileExplorerService {
  async listDirectory(
    target: FileExplorerTarget,
    requestedPath = "",
    options?: { includeHidden?: boolean },
  ): Promise<FileExplorerListResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const pathMetadata = await getFileMetadata(
      target.executor,
      absolutePath,
      { includeContentHash: false },
    );

    if (!pathMetadata) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (pathMetadata.kind !== "directory") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a directory");
    }

    const includeHidden = options?.includeHidden ?? true;
    const directoryEntries = await target.executor.listDirectoryEntries(
      absolutePath,
      {
        includeHidden,
      },
    );
    const entries = directoryEntries.map((entry) => toFileNode(
      target,
      joinExecutionPath(
        target.executor.pathStyle,
        absolutePath,
        entry.name,
      ),
      entry.kind,
    ));

    return {
      directory: toRelativePath(
        target.rootDirectory,
        absolutePath,
        target.executor.pathStyle,
      ),
      entries: sortEntries(entries),
    };
  }

  async loadTree(
    target: FileExplorerTarget,
  ): Promise<FileExplorerTreeResult> {
    const entries = await loadFullTree(target);
    return {
      entriesByDirectory: toEntriesByDirectory(entries),
    };
  }

  async readFile(target: FileExplorerTarget, requestedPath: string): Promise<FileExplorerReadResult> {
    const absolutePath = resolveTargetPath(target, requestedPath);
    const metadata = await getFileMetadata(target.executor, absolutePath);

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
    const metadata = await getFileMetadata(target.executor, absolutePath);

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

    const data = await readFileBytes(target, absolutePath);
    const detectedMimeType = detectBrowserImageMimeType(data);
    if (!detectedMimeType) {
      throw new FileExplorerError(
        "invalid_preview_type",
        "Requested file is not a browser-renderable image",
      );
    }

    return {
      file: {
        ...file,
        isImage: true,
        mimeType: detectedMimeType,
      },
      contentType: detectedMimeType,
      data,
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
    if (executionPathsEqual(
      sourceAbsolutePath,
      destinationAbsolutePath,
      target.executor.pathStyle,
    )) {
      return {
        success: true,
        file: sourceFile,
        previousPath: sourceFile.path,
        overwritten: false,
      };
    }

    const existingDestination = await getFileMetadata(target.executor, destinationAbsolutePath, {
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

    const moved = await target.executor.movePath(
      sourceAbsolutePath,
      destinationAbsolutePath,
      { overwrite: options?.overwrite },
    );
    if (!moved.success) {
      return await throwMoveFailure(
        target,
        destinationAbsolutePath,
        moved,
        "file_not_found",
        "Failed to rename file",
      );
    }

    const updatedFile = await this.getMetadata(
      target,
      toRelativePath(
        target.rootDirectory,
        destinationAbsolutePath,
        target.executor.pathStyle,
      ),
    );
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

    const deleted = await target.executor.deletePath(
      absolutePath,
      {
        kind: file.kind,
        recursive: file.kind === "directory",
      },
    );
    if (!deleted) {
      throw fileExplorerOperationError("Failed to delete file");
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
      (session) => (
        session.targetId === target.id
        && executionPathsEqual(
          session.rootDirectory,
          normalizeRootDirectory(
            target.rootDirectory,
            target.executor.pathStyle,
          ),
          target.executor.pathStyle,
        )
      ),
    ).length;
    if (activeSessionsForTarget >= MAX_UPLOAD_SESSIONS) {
      throw fileExplorerOperationError("Too many active upload sessions");
    }

    const safeName = assertSafeBaseName(fileName);
    const normalizedDirectory = directory.trim();
    const directoryAbsolutePath = resolveTargetPath(target, normalizedDirectory);
    const directoryMetadata = await getFileMetadata(
      target.executor,
      directoryAbsolutePath,
      { includeContentHash: false },
    );
    if (!directoryMetadata) {
      throw new FileExplorerError("file_not_found", "Requested path does not exist");
    }
    if (directoryMetadata.kind !== "directory") {
      throw new FileExplorerError("invalid_path_type", "Requested path is not a directory");
    }

    const finalAbsolutePath = resolveTargetPath(target, pathPosix.join(normalizedDirectory, safeName));
    const relativePath = toRelativePath(
      target.rootDirectory,
      finalAbsolutePath,
      target.executor.pathStyle,
    );
    const existingFile = await getFileMetadata(target.executor, finalAbsolutePath, {
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
    const tempAbsolutePath = joinExecutionPath(
      target.executor.pathStyle,
      resolveUploadTempDirectory(target),
      `${uploadId}-${safeName}`,
    );
    const session: FileExplorerUploadSession = {
      id: uploadId,
      targetId: target.id,
      rootDirectory: normalizeRootDirectory(
        target.rootDirectory,
        target.executor.pathStyle,
      ),
      directory: toRelativePath(
        target.rootDirectory,
        directoryAbsolutePath,
        target.executor.pathStyle,
      ),
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
      maxBytes: session.size - session.bytesWritten,
      signal: options?.signal,
    });
    if (!result.success) {
      if (result.errorCode === "size_limit") {
        throw new FileExplorerError(
          "upload_size_exceeded",
          "Upload chunk exceeds the remaining declared file size",
        );
      }
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

    const existingFinalFile = await getFileMetadata(target.executor, session.finalAbsolutePath, {
      includeContentHash: false,
    });
    const existingFinalEntry = existingFinalFile ? toFileEntry(target, session.finalAbsolutePath, existingFinalFile) : null;
    if (existingFinalEntry && !session.overwrite) {
      throw new FileExplorerConflictError("Destination already exists", existingFinalEntry);
    }
    if (session.overwrite) {
      assertOverwriteKindCompatible(existingFinalEntry, "file");
    }

    if (session.size === 0) {
      const initialized = await target.executor.writeFile(session.tempAbsolutePath, "");
      if (!initialized) {
        throw fileExplorerOperationError("Failed to initialize empty upload");
      }
    }

    const moved = await target.executor.movePath(
      session.tempAbsolutePath,
      session.finalAbsolutePath,
      { overwrite: session.overwrite },
    );
    if (!moved.success) {
      return await throwMoveFailure(
        target,
        session.finalAbsolutePath,
        moved,
        "invalid_upload_state",
        "Failed to complete upload",
      );
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
    await target.executor.deletePath(session.tempAbsolutePath, {
      kind: "file",
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
    const normalizedRootDirectory = normalizeRootDirectory(
      target.rootDirectory,
      target.executor.pathStyle,
    );
    const expiredSessions = Array.from(uploadSessions.values()).filter((session) => {
      return session.targetId === target.id
        && executionPathsEqual(
          session.rootDirectory,
          normalizedRootDirectory,
          target.executor.pathStyle,
        )
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
    if (!(await target.executor.directoryExists(tempDirectory))) {
      return;
    }
    const entries = await target.executor.listDirectoryEntries(tempDirectory, {
      includeHidden: true,
    });
    const expirationThreshold = Date.now() - UPLOAD_SESSION_TTL_MS;
    for (const entry of entries) {
      if (entry.kind !== "file") {
        continue;
      }
      const path = joinExecutionPath(
        target.executor.pathStyle,
        tempDirectory,
        entry.name,
      );
      const metadata = await getFileMetadata(target.executor, path, {
        includeContentHash: false,
      });
      if (metadata && metadata.modifiedAtMs < expirationThreshold) {
        await target.executor.deletePath(path, { kind: "file" });
      }
    }
    await target.executor.deletePath(tempDirectory, {
      kind: "directory",
      recursive: false,
    });
  }

  private async deleteUploadTempFile(
    target: FileExplorerTarget,
    session: FileExplorerUploadSession,
  ): Promise<void> {
    await target.executor.deletePath(session.tempAbsolutePath, {
      kind: "file",
    });
  }

  private async cleanupUploadTempDirectory(
    target: FileExplorerTarget,
    _session: FileExplorerUploadSession,
  ): Promise<void> {
    await target.executor.deletePath(resolveUploadTempDirectory(target), {
      kind: "directory",
      recursive: false,
    });
  }
}

export const fileExplorerService = new FileExplorerService();
