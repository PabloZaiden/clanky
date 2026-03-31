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

  if (normalizedPath !== root && !normalizedPath.startsWith(`${root}/`)) {
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

function buildVersionToken(timestampSeconds: string, size: number): string {
  return `${timestampSeconds}:${size}`;
}

function parseEntryLine(
  workspace: Workspace,
  parentAbsolutePath: string,
  line: string,
): WorkspaceFileEntry {
  const [name, typeFlag, sizeText, timestampSeconds] = line.split(LIST_SEPARATOR);
  if (!name || !typeFlag || !sizeText || !timestampSeconds) {
    throw new Error(`Invalid file entry output: ${line}`);
  }

  const size = Number.parseInt(sizeText, 10);
  if (!Number.isFinite(size)) {
    throw new Error(`Invalid file size: ${sizeText}`);
  }

  const absolutePath = pathPosix.join(parentAbsolutePath, name);

  return {
    name,
    path: toRelativeWorkspacePath(workspace, absolutePath),
    kind: typeFlag === "d" ? "directory" : "file",
    size,
    modifiedAt: parseModifiedAt(timestampSeconds),
    versionToken: buildVersionToken(timestampSeconds, size),
  };
}

async function runMetadataCommand(
  executor: CommandExecutor,
  absolutePath: string,
): Promise<{ kind: "file" | "directory"; size: number; modifiedAt: string; versionToken: string } | null> {
  const result = await executor.exec(
    "bash",
    [
      "-lc",
      "if [ ! -e \"$1\" ]; then exit 2; fi; find \"$1\" -maxdepth 0 -printf '%y\\t%s\\t%T@\\n'",
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

  const [typeFlag, sizeText, timestampSeconds] = result.stdout.trim().split(LIST_SEPARATOR);
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
    versionToken: buildVersionToken(timestampSeconds, size),
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
  async listDirectory(workspace: Workspace, requestedPath = ""): Promise<WorkspaceFileListResponse> {
    const absolutePath = resolveWorkspacePath(workspace, requestedPath);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    const metadata = await runMetadataCommand(executor, absolutePath);

    if (!metadata) {
      throw new Error("Requested path does not exist");
    }
    if (metadata.kind !== "directory") {
      throw new Error("Requested path is not a directory");
    }

    const result = await executor.exec(
      "bash",
      [
        "-lc",
        "find \"$1\" -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n' | sort",
        "workspace-file-list",
        absolutePath,
      ],
      {
        logFailures: false,
      },
    );

    if (!result.success) {
      throw new Error(result.stderr.trim() || "Failed to list directory");
    }

    const entries = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseEntryLine(workspace, absolutePath, line))
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
      && options?.expectedVersionToken !== undefined
      && (currentFile?.versionToken ?? null) !== (options.expectedVersionToken ?? null)
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
