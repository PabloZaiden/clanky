/**
 * Shared file explorer API helpers.
 */

import { appFetch } from "../lib/public-path";
import { getStoredSshCredentialToken } from "../lib/ssh-browser-credentials";
import type {
  WorkspaceFileConflictResponse,
  WorkspaceFileEntry,
  SshServerFileListResponse,
  SshServerFileMetadataResponse,
  SshServerFileReadResponse,
  SshServerFileWriteResponse,
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

export type FileExplorerTarget =
  | { type: "workspace"; id: string }
  | { type: "server"; id: string };

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

async function buildFileExplorerRequestInit(
  target: FileExplorerTarget,
  options?: WorkspaceFileRequestOptions,
  init?: RequestInit,
): Promise<RequestInit> {
  const headers = new Headers(init?.headers);

  if (target.type === "server") {
    const credentialToken = await getStoredSshCredentialToken(target.id);
    if (!credentialToken) {
      throw new Error("Enter the SSH password for this server.");
    }
    headers.set("x-ralpher-ssh-credential-token", credentialToken);
  }

  return {
    ...init,
    headers,
    signal: options?.signal,
  };
}

function getFileExplorerBasePath(target: FileExplorerTarget): string {
  return target.type === "workspace"
    ? `/api/workspaces/${target.id}/files`
    : `/api/ssh-servers/${target.id}/files`;
}

export async function listFileExplorerFilesApi(
  target: FileExplorerTarget,
  path = "",
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileListResponse | SshServerFileListResponse> {
  const searchParams = new URLSearchParams({
    path,
  });
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileListResponse | SshServerFileListResponse;
}

export async function readFileExplorerFileApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileReadResponse | SshServerFileReadResponse> {
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/content?path=${encodeURIComponent(path)}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileReadResponse | SshServerFileReadResponse;
}

export async function getFileExplorerFileMetadataApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileMetadataResponse | SshServerFileMetadataResponse> {
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/metadata?path=${encodeURIComponent(path)}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileMetadataResponse | SshServerFileMetadataResponse;
}

export async function writeFileExplorerFileApi(
  target: FileExplorerTarget,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse | SshServerFileWriteResponse> {
  const requestOptions = await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const response = await appFetch(`${getFileExplorerBasePath(target)}/write`, requestOptions);
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileWriteResponse | SshServerFileWriteResponse;
}

export async function listWorkspaceFilesApi(
  workspaceId: string,
  path = "",
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileListResponse> {
  const response = await listFileExplorerFilesApi({ type: "workspace", id: workspaceId }, path, options);
  return response as WorkspaceFileListResponse;
}

export async function readWorkspaceFileApi(
  workspaceId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileReadResponse> {
  const response = await readFileExplorerFileApi({ type: "workspace", id: workspaceId }, path, options);
  return response as WorkspaceFileReadResponse;
}

export async function getWorkspaceFileMetadataApi(
  workspaceId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileMetadataResponse> {
  const response = await getFileExplorerFileMetadataApi({ type: "workspace", id: workspaceId }, path, options);
  return response as WorkspaceFileMetadataResponse;
}

export async function writeWorkspaceFileApi(
  workspaceId: string,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse> {
  const response = await writeFileExplorerFileApi({ type: "workspace", id: workspaceId }, request, options);
  return response as WorkspaceFileWriteResponse;
}

export async function listServerFilesApi(
  serverId: string,
  path = "",
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileListResponse> {
  const response = await listFileExplorerFilesApi({ type: "server", id: serverId }, path, options);
  return response as SshServerFileListResponse;
}

export async function readServerFileApi(
  serverId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileReadResponse> {
  const response = await readFileExplorerFileApi({ type: "server", id: serverId }, path, options);
  return response as SshServerFileReadResponse;
}

export async function getServerFileMetadataApi(
  serverId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileMetadataResponse> {
  const response = await getFileExplorerFileMetadataApi({ type: "server", id: serverId }, path, options);
  return response as SshServerFileMetadataResponse;
}

export async function writeServerFileApi(
  serverId: string,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileWriteResponse> {
  const response = await writeFileExplorerFileApi({ type: "server", id: serverId }, request, options);
  return response as SshServerFileWriteResponse;
}
