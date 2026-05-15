/**
 * Shared file explorer API helpers.
 */

import { appFetch } from "../lib/public-path";
import {
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";
import type {
  WorkspaceFileConflictResponse,
  WorkspaceFileEntry,
  SshServerFileListResponse,
  SshServerFileMetadataResponse,
  SshServerFileReadResponse,
  SshServerFileTreeResponse,
  SshServerFileWriteResponse,
  WorkspaceFileListResponse,
  WorkspaceFileMetadataResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileTreeResponse,
  WorkspaceFileWriteResponse,
  WriteWorkspaceFileRequest,
} from "../types";

interface ApiErrorBody {
  error?: string;
  message?: string;
  currentFile?: WorkspaceFileEntry | null;
}

const MAX_CONCURRENT_METADATA_REQUESTS = 10;

let activeMetadataRequests = 0;
const queuedMetadataRequestStarters: Array<() => void> = [];

export interface WorkspaceFileRequestOptions {
  signal?: AbortSignal;
  startDirectory?: string;
}

export type FileExplorerTarget =
  | { type: "workspace"; id: string; startDirectory?: string }
  | { type: "server"; id: string; startDirectory?: string };

export class WorkspaceFileConflictError extends Error {
  readonly currentFile: WorkspaceFileEntry | null;

  constructor(message: string, currentFile: WorkspaceFileEntry | null) {
    super(message);
    this.name = "WorkspaceFileConflictError";
    this.currentFile = currentFile;
  }
}

export type FileExplorerCredentialErrorCode = "missing_ssh_credential" | "invalid_ssh_credential";

export class FileExplorerCredentialError extends Error {
  readonly code: FileExplorerCredentialErrorCode;

  constructor(message: string, code: FileExplorerCredentialErrorCode) {
    super(message);
    this.name = "FileExplorerCredentialError";
    this.code = code;
  }
}

function createMissingSshCredentialError(): FileExplorerCredentialError {
  return new FileExplorerCredentialError("Enter the SSH password for this server.", "missing_ssh_credential");
}

function createInvalidSshCredentialError(message?: string): FileExplorerCredentialError {
  return new FileExplorerCredentialError(
    message ?? "The SSH password for this server was rejected. Enter it again.",
    "invalid_ssh_credential",
  );
}

export async function requireFileExplorerServerCredentialToken(serverId: string): Promise<string> {
  const hadStoredCredential = getStoredSshServerCredential(serverId) !== null;

  try {
    const credentialToken = await getStoredSshCredentialToken(serverId);
    if (credentialToken) {
      return credentialToken;
    }
  } catch (error) {
    const errorCode = (error as Error & { code?: string }).code;
    if (
      errorCode === "invalid_credential_token"
      || errorCode === "invalid_encrypted_credential"
    ) {
      throw createInvalidSshCredentialError();
    }
    throw error;
  }

  if (hadStoredCredential) {
    throw createInvalidSshCredentialError();
  }

  throw createMissingSshCredentialError();
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

  if (body?.error === "invalid_credential_token") {
    throw createInvalidSshCredentialError("The SSH password for this server expired or was rejected. Enter it again.");
  }

  throw new Error(body?.message ?? `File explorer request failed with status ${response.status}`);
}

async function buildFileExplorerRequestInit(
  target: FileExplorerTarget,
  options?: WorkspaceFileRequestOptions,
  init?: RequestInit,
): Promise<RequestInit> {
  const headers = new Headers(init?.headers);

  if (target.type === "server") {
    const credentialToken = await requireFileExplorerServerCredentialToken(target.id);
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

async function runLimitedMetadataRequest<T>(request: () => Promise<T>): Promise<T> {
  if (activeMetadataRequests >= MAX_CONCURRENT_METADATA_REQUESTS) {
    await new Promise<void>((resolve) => {
      queuedMetadataRequestStarters.push(resolve);
    });
  }

  activeMetadataRequests += 1;
  try {
    return await request();
  } finally {
    activeMetadataRequests -= 1;
    queuedMetadataRequestStarters.shift()?.();
  }
}

function buildFileExplorerSearchParams(
  target: FileExplorerTarget,
  values: Record<string, string>,
  options?: WorkspaceFileRequestOptions,
): URLSearchParams {
  const searchParams = new URLSearchParams(values);
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  if (startDirectory) {
    searchParams.set("startDirectory", startDirectory);
  }
  return searchParams;
}

export async function listFileExplorerFilesApi(
  target: FileExplorerTarget,
  path = "",
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileListResponse | SshServerFileListResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
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
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/content?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileReadResponse | SshServerFileReadResponse;
}

export async function loadFileExplorerTreeApi(
  target: FileExplorerTarget,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileTreeResponse | SshServerFileTreeResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {}, options);
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/tree?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileTreeResponse | SshServerFileTreeResponse;
}

export async function getFileExplorerFileMetadataApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileMetadataResponse | SshServerFileMetadataResponse> {
  return await runLimitedMetadataRequest(async () => {
    const searchParams = buildFileExplorerSearchParams(target, {
      path,
    }, options);
    const response = await appFetch(
      `${getFileExplorerBasePath(target)}/metadata?${searchParams.toString()}`,
      await buildFileExplorerRequestInit(target, options),
    );
    if (!response.ok) {
      await parseWorkspaceFileError(response);
    }
    return await response.json() as WorkspaceFileMetadataResponse | SshServerFileMetadataResponse;
  });
}

export async function readFileExplorerImagePreviewApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<Blob> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/preview?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.blob();
}

export async function downloadFileExplorerFileApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<Blob> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/download?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.blob();
}

export async function writeFileExplorerFileApi(
  target: FileExplorerTarget,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse | SshServerFileWriteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const requestOptions = await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(startDirectory ? { startDirectory } : {}),
    }),
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

export async function loadWorkspaceFileTreeApi(
  workspaceId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileTreeResponse> {
  const response = await loadFileExplorerTreeApi({ type: "workspace", id: workspaceId }, options);
  return response as WorkspaceFileTreeResponse;
}

export async function writeWorkspaceFileApi(
  workspaceId: string,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse> {
  const response = await writeFileExplorerFileApi({ type: "workspace", id: workspaceId }, request, options);
  return response as WorkspaceFileWriteResponse;
}

export async function downloadWorkspaceFileApi(
  workspaceId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<Blob> {
  return await downloadFileExplorerFileApi({ type: "workspace", id: workspaceId }, path, options);
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

export async function loadServerFileTreeApi(
  serverId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileTreeResponse> {
  const response = await loadFileExplorerTreeApi({ type: "server", id: serverId }, options);
  return response as SshServerFileTreeResponse;
}

export async function writeServerFileApi(
  serverId: string,
  request: WriteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<SshServerFileWriteResponse> {
  const response = await writeFileExplorerFileApi({ type: "server", id: serverId }, request, options);
  return response as SshServerFileWriteResponse;
}

export async function downloadServerFileApi(
  serverId: string,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<Blob> {
  return await downloadFileExplorerFileApi({ type: "server", id: serverId }, path, options);
}
