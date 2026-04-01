/**
 * Shared workspace file explorer API helpers.
 */

import { appFetch } from "../lib/public-path";
import type {
  WorkspaceFileConflictResponse,
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
  WorkspaceFileMetadataResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileWriteResponse,
  WriteWorkspaceFileRequest,
} from "../types";

interface ApiErrorBody {
  error?: string;
  message?: string;
  currentFile?: WorkspaceFileEntry | null;
}

export interface WorkspaceFileRequestOptions {
  signal?: AbortSignal;
}

export class WorkspaceFileConflictError extends Error {
  readonly currentFile: WorkspaceFileEntry | null;

  constructor(message: string, currentFile: WorkspaceFileEntry | null) {
    super(message);
    this.name = "WorkspaceFileConflictError";
    this.currentFile = currentFile;
  }
}

async function parseWorkspaceFileError(response: Response): Promise<never> {
  let body: ApiErrorBody | null = null;
  try {
    body = await response.json() as ApiErrorBody;
  } catch {
    body = null;
  }

  if (response.status === 409 && body?.error === "file_conflict") {
    const conflict = body as WorkspaceFileConflictResponse;
    throw new WorkspaceFileConflictError(conflict.message, conflict.currentFile);
  }

  throw new Error(body?.message ?? `Workspace file request failed with status ${response.status}`);
}

export async function listWorkspaceFilesApi(
  workspaceId: string,
  path = "",
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileListResponse> {
  const searchParams = new URLSearchParams({
    path,
  });
  const response = await appFetch(
    `/api/workspaces/${workspaceId}/files?${searchParams.toString()}`,
    {
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileListResponse;
}

export async function readWorkspaceFileApi(
  workspaceId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileReadResponse> {
  const response = await appFetch(
    `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
    {
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileReadResponse;
}

export async function getWorkspaceFileMetadataApi(
  workspaceId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileMetadataResponse> {
  const response = await appFetch(
    `/api/workspaces/${workspaceId}/files/metadata?path=${encodeURIComponent(path)}`,
    {
      signal: options?.signal,
    },
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileMetadataResponse;
}

export async function writeWorkspaceFileApi(
  workspaceId: string,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse> {
  const response = await appFetch(`/api/workspaces/${workspaceId}/files/write`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: options?.signal,
  });
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileWriteResponse;
}
