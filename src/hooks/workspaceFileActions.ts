/**
 * Shared file explorer API helpers.
 */

import { appFetch, appPath } from "../lib/public-path";
import { isApiErrorCode } from "../lib/api-error";
import {
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
} from "../lib/ssh-browser-credentials";
import type { WorkspaceFileEntry } from "@/shared";
import type {
  WorkspaceFileConflictResponse,
  SshServerFileDeleteResponse,
  SshServerFileListResponse,
  SshServerFileMetadataResponse,
  SshServerFileRenameResponse,
  SshServerFileReadResponse,
  SshServerFileTreeResponse,
  SshServerFileUploadCancelResponse,
  SshServerFileUploadChunkResponse,
  SshServerFileUploadCompleteResponse,
  SshServerFileUploadCreateResponse,
  SshServerFileWriteResponse,
  DeleteWorkspaceFileRequest,
  RenameWorkspaceFileRequest,
  CreateWorkspaceFileUploadRequest,
  WorkspaceFileListResponse,
  WorkspaceFileMetadataResponse,
  WorkspaceFileRenameResponse,
  WorkspaceFileDeleteResponse,
  WorkspaceFileReadResponse,
  WorkspaceFileTreeResponse,
  WorkspaceFileUploadCancelResponse,
  WorkspaceFileUploadChunkResponse,
  WorkspaceFileUploadCompleteResponse,
  WorkspaceFileUploadCreateResponse,
  WorkspaceFileWriteResponse,
  WriteWorkspaceFileRequest,
} from "@/contracts";

interface ApiErrorBody {
  error?: string;
  message?: string;
  currentFile?: WorkspaceFileEntry | null;
}

const MAX_CONCURRENT_METADATA_REQUESTS = 10;
const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 800 * 1024;
const MAX_UPLOAD_CHUNK_ATTEMPTS = 3;

let activeMetadataRequests = 0;
const queuedMetadataRequestStarters: Array<() => void> = [];

export interface WorkspaceFileRequestOptions {
  signal?: AbortSignal;
  startDirectory?: string;
}

export interface UploadFileExplorerFileOptions extends WorkspaceFileRequestOptions {
  overwrite?: boolean;
  chunkSizeBytes?: number;
  onProgress?: (progress: { bytesUploaded: number; totalBytes: number }) => void;
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
    if (
      isApiErrorCode(error, "invalid_credential_token")
      || isApiErrorCode(error, "invalid_encrypted_credential")
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
    headers.set("x-clanky-ssh-credential-token", credentialToken);
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

function createAbortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function acquireMetadataRequestSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  if (activeMetadataRequests < MAX_CONCURRENT_METADATA_REQUESTS) {
    activeMetadataRequests += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const startQueuedRequest = () => {
      signal?.removeEventListener("abort", abortQueuedRequest);
      activeMetadataRequests += 1;
      resolve();
    };
    const abortQueuedRequest = () => {
      const index = queuedMetadataRequestStarters.indexOf(startQueuedRequest);
      if (index >= 0) {
        queuedMetadataRequestStarters.splice(index, 1);
      }
      reject(createAbortError(signal!));
    };

    signal?.addEventListener("abort", abortQueuedRequest, { once: true });
    if (signal?.aborted) {
      abortQueuedRequest();
      return;
    }
    queuedMetadataRequestStarters.push(startQueuedRequest);
  });
}

async function runLimitedMetadataRequest<T>(signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
  await acquireMetadataRequestSlot(signal);
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
  return await runLimitedMetadataRequest(options?.signal, async () => {
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

export async function getFileExplorerDownloadUrl(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<string> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  if (target.type === "server") {
    searchParams.set("credentialToken", await requireFileExplorerServerCredentialToken(target.id));
  }
  return appPath(`${getFileExplorerBasePath(target)}/download?${searchParams.toString()}`);
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

export async function renameFileExplorerNodeApi(
  target: FileExplorerTarget,
  request: RenameWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileRenameResponse | SshServerFileRenameResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const response = await appFetch(`${getFileExplorerBasePath(target)}/rename`, await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  }));
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileRenameResponse | SshServerFileRenameResponse;
}

export async function deleteFileExplorerNodeApi(
  target: FileExplorerTarget,
  request: DeleteWorkspaceFileRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileDeleteResponse | SshServerFileDeleteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const response = await appFetch(`${getFileExplorerBasePath(target)}/delete`, await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  }));
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileDeleteResponse | SshServerFileDeleteResponse;
}

async function createFileExplorerUploadApi(
  target: FileExplorerTarget,
  request: CreateWorkspaceFileUploadRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCreateResponse | SshServerFileUploadCreateResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const response = await appFetch(`${getFileExplorerBasePath(target)}/upload`, await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  }));
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileUploadCreateResponse | SshServerFileUploadCreateResponse;
}

async function writeFileExplorerUploadChunkApi(
  target: FileExplorerTarget,
  uploadId: string,
  offset: number,
  chunk: Blob,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadChunkResponse | SshServerFileUploadChunkResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {
    uploadId,
    offset: String(offset),
  }, options);
  const response = await appFetch(
    `${getFileExplorerBasePath(target)}/upload/chunk?${searchParams.toString()}`,
    await buildFileExplorerRequestInit(target, options, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    }),
  );
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileUploadChunkResponse | SshServerFileUploadChunkResponse;
}

async function completeFileExplorerUploadApi(
  target: FileExplorerTarget,
  uploadId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCompleteResponse | SshServerFileUploadCompleteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const response = await appFetch(`${getFileExplorerBasePath(target)}/upload/complete`, await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      uploadId,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  }));
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileUploadCompleteResponse | SshServerFileUploadCompleteResponse;
}

async function cancelFileExplorerUploadApi(
  target: FileExplorerTarget,
  uploadId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCancelResponse | SshServerFileUploadCancelResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const response = await appFetch(`${getFileExplorerBasePath(target)}/upload/cancel`, await buildFileExplorerRequestInit(target, options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      uploadId,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  }));
  if (!response.ok) {
    await parseWorkspaceFileError(response);
  }
  return await response.json() as WorkspaceFileUploadCancelResponse | SshServerFileUploadCancelResponse;
}

async function writeUploadChunkWithRetries(
  target: FileExplorerTarget,
  uploadId: string,
  offset: number,
  chunk: Blob,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadChunkResponse | SshServerFileUploadChunkResponse> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_UPLOAD_CHUNK_ATTEMPTS; attempt += 1) {
    if (options?.signal?.aborted) {
      throw createAbortError(options.signal);
    }
    try {
      return await writeFileExplorerUploadChunkApi(target, uploadId, offset, chunk, options);
    } catch (error) {
      lastError = error;
      if (options?.signal?.aborted || attempt === MAX_UPLOAD_CHUNK_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function uploadFileExplorerFileApi(
  target: FileExplorerTarget,
  directory: string,
  file: File,
  options?: UploadFileExplorerFileOptions,
): Promise<WorkspaceFileUploadCompleteResponse | SshServerFileUploadCompleteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const session = await createFileExplorerUploadApi(target, {
    directory,
    fileName: file.name,
    size: file.size,
    contentType: file.type || undefined,
    lastModified: file.lastModified,
    overwrite: options?.overwrite ?? false,
    startDirectory: startDirectory ?? null,
  }, { startDirectory, signal: options?.signal });

  let offset = 0;
  const chunkSize = options?.chunkSizeBytes ?? DEFAULT_UPLOAD_CHUNK_SIZE_BYTES;
  try {
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const response = await writeUploadChunkWithRetries(target, session.uploadId, offset, chunk, {
        startDirectory,
        signal: options?.signal,
      });
      offset = response.nextOffset;
      options?.onProgress?.({
        bytesUploaded: offset,
        totalBytes: file.size,
      });
    }
    return await completeFileExplorerUploadApi(target, session.uploadId, {
      startDirectory,
      signal: options?.signal,
    });
  } catch (error) {
    await cancelFileExplorerUploadApi(target, session.uploadId, {
      startDirectory,
      signal: options?.signal?.aborted ? undefined : options?.signal,
    }).catch(() => undefined);
    throw error;
  }
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
