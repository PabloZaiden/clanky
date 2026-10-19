/**
 * Canonical Clanky-managed paths on an execution host.
 */

import {
  executionPathsEqual,
  isExecutionPathWithinRoot,
  isWindowsReservedPathComponent,
  joinExecutionPath,
  normalizeExecutionPath,
  normalizeExecutionRoot,
  relativeExecutionPath,
  type ExecutionPathStyle,
} from "./execution-path";

export const MANAGED_WORKTREE_DIRECTORY_NAME = ".clanky-worktrees";
export const CHAT_HISTORY_EXPORT_DIRECTORY_NAME = ".clanky-chat-history";
export const CONVERSATION_ATTACHMENT_DIRECTORY_NAME = ".clanky-attachments";
export const PLANNING_DIRECTORY_NAME = ".clanky-planning";
export const PLAN_FILE_NAME = "plan.md";
export const STATUS_FILE_NAME = "status.md";
export const CHAT_HISTORY_TRANSCRIPT_FILE_NAME = "conversation.jsonl";
export const DEFAULT_PLAN_DISPLAY_PATH = `${PLANNING_DIRECTORY_NAME}/${PLAN_FILE_NAME}`;

export class InvalidManagedWorktreePathError extends Error {
  readonly code = "INVALID_MANAGED_WORKTREE_PATH";
  readonly path: string;

  constructor(
    path: string,
    message = `Invalid managed worktree path: '${path}'`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InvalidManagedWorktreePathError";
    this.path = path;
  }
}

export class ManagedPathService {
  constructor(readonly pathStyle: ExecutionPathStyle) {}

  normalizeManagedWorktreeIdentifier(identifier: string): string {
    return this.normalizeManagedIdentifier(identifier, "Managed worktree");
  }

  private normalizeManagedIdentifier(identifier: string, label: string): string {
    const normalizedIdentifier = identifier.trim();
    if (
      normalizedIdentifier.length === 0
      || normalizedIdentifier === "."
      || normalizedIdentifier === ".."
      || normalizedIdentifier.includes("/")
      || normalizedIdentifier.includes("\\")
      || normalizedIdentifier.includes("\0")
    ) {
      throw new InvalidManagedWorktreePathError(
        identifier,
        `${label} identifiers must be a non-empty, single safe path component`,
      );
    }

    try {
      normalizeExecutionPath(normalizedIdentifier, this.pathStyle);
    } catch (error) {
      throw new InvalidManagedWorktreePathError(
        identifier,
        `${label} identifiers must be valid on the execution host`,
        { cause: error },
      );
    }
    return normalizedIdentifier;
  }

  getManagedWorktreeRoot(repoDirectory: string): string {
    const normalizedRepoDirectory = this.normalizeRepositoryDirectory(repoDirectory);
    return joinExecutionPath(
      this.pathStyle,
      normalizedRepoDirectory,
      MANAGED_WORKTREE_DIRECTORY_NAME,
    );
  }

  getManagedWorktreePath(repoDirectory: string, identifier: string): string {
    return joinExecutionPath(
      this.pathStyle,
      this.getManagedWorktreeRoot(repoDirectory),
      this.normalizeManagedWorktreeIdentifier(identifier),
    );
  }

  getChatHistoryExportDirectoryPath(
    directory: string,
    chatId: string,
    recoveryId: string,
  ): string {
    return joinExecutionPath(
      this.pathStyle,
      normalizeExecutionRoot(directory, this.pathStyle),
      CHAT_HISTORY_EXPORT_DIRECTORY_NAME,
      this.normalizeManagedIdentifier(chatId, "Chat"),
      this.normalizeManagedIdentifier(recoveryId, "Recovery"),
    );
  }

  getConversationAttachmentDirectory(directory: string, context: string): string {
    return joinExecutionPath(
      this.pathStyle,
      normalizeExecutionRoot(directory, this.pathStyle),
      CONVERSATION_ATTACHMENT_DIRECTORY_NAME,
      this.normalizeManagedIdentifier(context, "Attachment context"),
    );
  }

  getConversationAttachmentPath(options: {
    directory: string;
    context: string;
    message: string;
    attachment: string;
    filename: string;
  }): string {
    let filename = options.filename.trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
      .replace(/[. ]+$/g, "");
    if (!filename || isWindowsReservedPathComponent(filename)) {
      filename = `_${filename || "file"}`;
    }
    if (filename.length > 160 || Buffer.byteLength(filename, "utf8") > 180) {
      const dot = filename.lastIndexOf(".");
      const extension = dot > 0 ? Array.from(filename.slice(dot)).slice(0, 20).join("") : "";
      const stem = Array.from(dot > 0 ? filename.slice(0, dot) : filename).slice(0, 160 - extension.length);
      while (Buffer.byteLength(`${stem.join("")}${extension}`, "utf8") > 180) stem.pop();
      filename = `${stem.join("")}${extension}`;
    }
    return joinExecutionPath(
      this.pathStyle,
      this.getConversationAttachmentDirectory(options.directory, options.context),
      this.normalizeManagedIdentifier(options.message, "Attachment message"),
      this.normalizeManagedIdentifier(options.attachment, "Attachment"),
      this.normalizeManagedIdentifier(filename, "Attachment filename"),
    );
  }

  getChatHistoryTranscriptPath(
    directory: string,
    chatId: string,
    recoveryId: string,
  ): string {
    return joinExecutionPath(
      this.pathStyle,
      this.getChatHistoryExportDirectoryPath(directory, chatId, recoveryId),
      CHAT_HISTORY_TRANSCRIPT_FILE_NAME,
    );
  }

  getChatHistoryAttachmentPath(
    directory: string,
    chatId: string,
    recoveryId: string,
    fileName: string,
  ): string {
    return joinExecutionPath(
      this.pathStyle,
      this.getChatHistoryExportDirectoryPath(directory, chatId, recoveryId),
      "attachments",
      this.normalizeManagedIdentifier(fileName, "Attachment"),
    );
  }

  isManagedWorktreePath(repoDirectory: string, worktreePath: string): boolean {
    if (!worktreePath.trim() || worktreePath.includes("\0")) {
      return false;
    }

    try {
      const root = this.getManagedWorktreeRoot(repoDirectory);
      const normalizedPath = normalizeExecutionPath(worktreePath, this.pathStyle);
      if (
        !isExecutionPathWithinRoot(root, normalizedPath, this.pathStyle)
        || executionPathsEqual(root, normalizedPath, this.pathStyle)
      ) {
        return false;
      }

      const identifier = relativeExecutionPath(root, normalizedPath, this.pathStyle);
      if (identifier !== this.normalizeManagedWorktreeIdentifier(identifier)) {
        return false;
      }
      return executionPathsEqual(
        normalizedPath,
        this.getManagedWorktreePath(repoDirectory, identifier),
        this.pathStyle,
      );
    } catch {
      // Invalid host-specific forms cannot identify a managed worktree.
      return false;
    }
  }

  assertManagedWorktreePath(repoDirectory: string, worktreePath: string): string {
    if (!this.isManagedWorktreePath(repoDirectory, worktreePath)) {
      throw new InvalidManagedWorktreePathError(
        worktreePath,
        `Managed worktree path must be a direct child of '${this.getManagedWorktreeRoot(repoDirectory)}'`,
      );
    }

    return normalizeExecutionPath(worktreePath, this.pathStyle);
  }

  assertCanonicalManagedWorktreePath(
    repoDirectory: string,
    identifier: string,
    worktreePath: string,
  ): string {
    const canonicalPath = this.getManagedWorktreePath(repoDirectory, identifier);
    const matches = this.pathStyle === "windows"
      ? executionPathsEqual(worktreePath, canonicalPath, this.pathStyle)
      : worktreePath === canonicalPath;
    if (!matches) {
      throw new InvalidManagedWorktreePathError(
        worktreePath,
        `Managed worktree path must equal the canonical path '${canonicalPath}'`,
      );
    }

    return canonicalPath;
  }

  getPlanningDirectoryPath(directory: string): string {
    return joinExecutionPath(
      this.pathStyle,
      normalizeExecutionRoot(directory, this.pathStyle),
      PLANNING_DIRECTORY_NAME,
    );
  }

  getPlanFilePath(directory: string): string {
    return joinExecutionPath(
      this.pathStyle,
      this.getPlanningDirectoryPath(directory),
      PLAN_FILE_NAME,
    );
  }

  getStatusFilePath(directory: string): string {
    return joinExecutionPath(
      this.pathStyle,
      this.getPlanningDirectoryPath(directory),
      STATUS_FILE_NAME,
    );
  }

  private normalizeRepositoryDirectory(repoDirectory: string): string {
    if (!repoDirectory.trim() || repoDirectory.includes("\0")) {
      throw new InvalidManagedWorktreePathError(
        repoDirectory,
        "A repository directory is required to construct a managed worktree path",
      );
    }

    try {
      return normalizeExecutionRoot(repoDirectory, this.pathStyle);
    } catch (error) {
      throw new InvalidManagedWorktreePathError(
        repoDirectory,
        "The repository directory is invalid for the execution host",
        { cause: error },
      );
    }
  }
}
