/**
 * Workspace file explorer service.
 *
 * All filesystem operations are executed through CommandExecutor so the
 * implementation works for both local and SSH-backed workspaces.
 */

import { posix as pathPosix } from "node:path";
import { backendManager } from "./backend-manager";
import type { CommandExecutor } from "./command-executor";
import type {
  Workspace,
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileWriteResponse,
} from "../types";

const LIST_SEPARATOR = "\t";

function normalizeWorkspaceRoot(directory: string): string {
  const normalized = pathPosix.normalize(directory.trim());
  return normalized === "." ? "/" : normalized.replace(/\/+$/, "") || "/";
}

function toRelativeWorkspacePath(workspace: Workspace, absolutePath: string): string {
  const root = normalizeWorkspaceRoot(workspace.directory);
  const normalizedPath = pathPosix.normalize(absolutePath);
  const relativePath = pathPosix.relative(root, normalizedPath);
  return relativePath === "." ? "" : relativePath;
}

function resolveWorkspacePath(workspace: Workspace, requestedPath: string): string {
  const root = normalizeWorkspaceRoot(workspace.directory);
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath || trimmedPath === ".") {
    return root;
  }

  const normalizedPath = trimmedPath.startsWith("/")
    ? pathPosix.normalize(trimmedPath)
    : pathPosix.normalize(pathPosix.join(root, trimmedPath));

  const relativePath = pathPosix.relative(root, normalizedPath);
  if (relativePath && (relativePath.startsWith("..") || pathPosix.isAbsolute(relativePath))) {
    throw new Error("Requested path must stay within the workspace directory");
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
      "workspace-file-metadata",
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

function toWorkspaceFileEntry(
  workspace: Workspace,
  absolutePath: string,
  metadata: { kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string },
): WorkspaceFileEntry {
  return {
    name: pathPosix.basename(absolutePath),
    path: toRelativeWorkspacePath(workspace, absolutePath),
    kind: metadata.kind,
    size: metadata.size,
    modifiedAt: metadata.modifiedAt,
    versionToken: metadata.versionToken,
  };
}

class WorkspaceFileService {
  async listDirectory(
    workspace: Workspace,
    requestedPath = "",
    options?: { includeHidden?: boolean },
  ): Promise<WorkspaceFileListResponse> {
    const absolutePath = resolveWorkspacePath(workspace, requestedPath);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const metadata = await runMetadataCommand(executor, absolutePath);

    if (!metadata) {
      throw new Error("Requested path does not exist");
    }
    if (metadata.kind !== "directory") {
      throw new Error("Requested path is not a directory");
    }

    const names = await executor.listDirectory(absolutePath, {
      includeHidden: options?.includeHidden,
    });
    const entries = (await Promise.all(
      names.map(async (name) => {
        const entryPath = pathPosix.join(absolutePath, name);
        const entryMetadata = await runMetadataCommand(executor, entryPath);
        if (!entryMetadata) {
          return null;
        }

        return toWorkspaceFileEntry(workspace, entryPath, entryMetadata);
      }),
    ))
      .filter((entry): entry is WorkspaceFileEntry => entry !== null)
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    return {
      workspaceId: workspace.id,
      directory: toRelativeWorkspacePath(workspace, absolutePath),
      entries,
    };
  }

  async readFile(workspace: Workspace, requestedPath: string): Promise<WorkspaceFileReadResponse> {
    const absolutePath = resolveWorkspacePath(workspace, requestedPath);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const metadata = await runMetadataCommand(executor, absolutePath);

    if (!metadata) {
      throw new Error("Requested file does not exist");
    }
    if (metadata.kind !== "file") {
      throw new Error("Requested path is not a file");
    }

    const content = await executor.readFile(absolutePath);
    if (content === null) {
      throw new Error("Requested file does not exist");
    }

    return {
      workspaceId: workspace.id,
      file: toWorkspaceFileEntry(workspace, absolutePath, metadata),
      content,
    };
  }

  async getMetadata(workspace: Workspace, requestedPath: string): Promise<WorkspaceFileEntry | null> {
    const absolutePath = resolveWorkspacePath(workspace, requestedPath);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const metadata = await runMetadataCommand(executor, absolutePath);
    return metadata ? toWorkspaceFileEntry(workspace, absolutePath, metadata) : null;
  }

  async writeFile(
    workspace: Workspace,
    requestedPath: string,
    content: string,
    options?: {
      expectedVersionToken?: string | null;
      overwrite?: boolean;
    },
  ): Promise<WorkspaceFileWriteResponse> {
    const absolutePath = resolveWorkspacePath(workspace, requestedPath);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const currentFile = await this.getMetadata(workspace, requestedPath);

    if (currentFile && currentFile.kind !== "file") {
      throw new Error("Requested path is not a file");
    }

    if (
      !options?.overwrite
      && (currentFile?.versionToken ?? null) !== (options?.expectedVersionToken ?? null)
    ) {
      const conflictError = new Error("File changed outside the editor");
      conflictError.name = "WorkspaceFileConflictError";
      throw Object.assign(conflictError, { currentFile });
    }

    const wroteFile = await executor.writeFile(absolutePath, content);
    if (!wroteFile) {
      throw new Error("Failed to write file");
    }

    const updatedFile = await this.getMetadata(workspace, requestedPath);
    if (!updatedFile) {
      throw new Error("File was written but metadata could not be read");
    }

    return {
      success: true,
      workspaceId: workspace.id,
      file: updatedFile,
      overwritten: Boolean(options?.overwrite && currentFile),
    };
  }
}

export const workspaceFileService = new WorkspaceFileService();
