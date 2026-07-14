/**
 * Stable failures for executor-backed file explorer operations.
 *
 * Core code exposes codes and metadata without depending on HTTP response
 * types. API boundaries decide how those failures map to public responses.
 */

import type { WorkspaceFileEntry } from "@/shared";
import { DomainError } from "./domain-error";

export type FileExplorerErrorCode =
  | "operation_failed"
  | "conflict"
  | "start_directory_not_found"
  | "invalid_start_directory_type"
  | "file_not_found"
  | "invalid_path_type"
  | "path_outside_root"
  | "root_not_mutable"
  | "invalid_file_name"
  | "upload_session_not_found"
  | "upload_session_target_mismatch"
  | "invalid_upload_state"
  | "invalid_preview_type";

export class FileExplorerError<
  TCode extends FileExplorerErrorCode = FileExplorerErrorCode,
> extends DomainError<TCode> {
  constructor(
    code: TCode,
    message: string,
    options?: {
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(code, message, options);
    this.name = "FileExplorerError";
  }
}

export class FileExplorerConflictError extends FileExplorerError<"conflict"> {
  readonly currentFile: WorkspaceFileEntry | null;

  constructor(message: string, currentFile: WorkspaceFileEntry | null) {
    super("conflict", message, {
      details: {
        conflict: true,
        currentFile,
      },
    });
    this.name = "FileExplorerConflictError";
    this.currentFile = currentFile;
  }
}

export function isFileExplorerConflictError(
  error: unknown,
): error is FileExplorerConflictError {
  return error instanceof FileExplorerConflictError;
}

export function fileExplorerOperationError(
  message: string,
  cause?: unknown,
): FileExplorerError<"operation_failed"> {
  return new FileExplorerError("operation_failed", message, { cause });
}

export function isFileExplorerError(error: unknown): error is FileExplorerError {
  return error instanceof FileExplorerError;
}
