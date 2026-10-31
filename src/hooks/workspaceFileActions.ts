/**
 * Shared file explorer API helpers.
 */

import { apiRequest } from "../lib/api-client";
import { isApiErrorCode } from "../lib/api-error";
import { appResourceUrl, appSaveResource } from "../lib/public-path";
import type { WebAppResourceUrl } from "@pablozaiden/webapp/web";
import type { WorkspaceFileEntry } from "@/shared";
import type {
  WorkspaceFileConflictResponse,
  DeleteFileExplorerRequest,
  RenameFileExplorerRequest,
  CreateFileExplorerUploadRequest,
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
  WriteFileExplorerRequest,
} from "@/contracts";
import { retryFileUploadChunk, uploadFileInChunks } from "@/shared";

const MAX_CONCURRENT_METADATA_REQUESTS = 10;

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
  | {
      type: "executionHost";
      id: string;
      kind: "local" | "mesh";
      startDirectory?: string;
    };

export class WorkspaceFileConflictError extends Error {
  readonly currentFile: WorkspaceFileEntry | null;

  constructor(message: string, currentFile: WorkspaceFileEntry | null) {
    super(message);
    this.name = "WorkspaceFileConflictError";
    this.currentFile = currentFile;
  }
}

function mapWorkspaceFileError(error: unknown): never {
  if (isApiErrorCode(error, "file_conflict")) {
    const currentFile = error.data?.["currentFile"];
    if (currentFile === null || typeof currentFile === "object") {
      throw new WorkspaceFileConflictError(
        typeof error.data?.["message"] === "string" ? error.data["message"] : error.message,
        currentFile as WorkspaceFileConflictResponse["currentFile"],
      );
    }
  }

  throw error;
}

async function requestFileExplorer<T>(
  path: string,
  options: RequestInit,
  fallbackMessage: string,
): Promise<T> {
  try {
    return await apiRequest<T>(path, {
      ...options,
      action: fallbackMessage,
      fallbackMessage,
    });
  } catch (error) {
    mapWorkspaceFileError(error);
  }
}

async function requestFileExplorerBlob(
  path: string,
  options: RequestInit,
  fallbackMessage: string,
): Promise<Blob> {
  try {
    return await apiRequest(path, {
      ...options,
      responseType: "blob",
      action: fallbackMessage,
      fallbackMessage,
    });
  } catch (error) {
    mapWorkspaceFileError(error);
  }
}

function buildFileExplorerRequestInit(
  options?: WorkspaceFileRequestOptions,
  init?: RequestInit,
): RequestInit {
  const headers = new Headers(init?.headers);

  return {
    ...init,
    headers,
    signal: options?.signal,
  };
}

function getFileExplorerBasePath(target: FileExplorerTarget): string {
  if (target.type === "workspace") {
    return `/api/workspaces/${target.id}/files`;
  }
  return `/api/execution-hosts/${target.kind}/${encodeURIComponent(target.id)}/files`;
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
): Promise<WorkspaceFileListResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  return await requestFileExplorer<WorkspaceFileListResponse>(
    `${getFileExplorerBasePath(target)}?${searchParams.toString()}`,
    buildFileExplorerRequestInit(options),
    "List file explorer files",
  );
}

export async function readFileExplorerFileApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileReadResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  return await requestFileExplorer<WorkspaceFileReadResponse>(
    `${getFileExplorerBasePath(target)}/content?${searchParams.toString()}`,
    buildFileExplorerRequestInit(options),
    "Read file explorer file",
  );
}

export async function loadFileExplorerTreeApi(
  target: FileExplorerTarget,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileTreeResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {}, options);
  return await requestFileExplorer<WorkspaceFileTreeResponse>(
    `${getFileExplorerBasePath(target)}/tree?${searchParams.toString()}`,
    buildFileExplorerRequestInit(options),
    "Load file explorer tree",
  );
}

export async function getFileExplorerFileMetadataApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileMetadataResponse> {
  return await runLimitedMetadataRequest(options?.signal, async () => {
    const searchParams = buildFileExplorerSearchParams(target, {
      path,
    }, options);
    return await requestFileExplorer<WorkspaceFileMetadataResponse>(
      `${getFileExplorerBasePath(target)}/metadata?${searchParams.toString()}`,
      buildFileExplorerRequestInit(options),
      "Load file explorer metadata",
    );
  });
}

export async function getFileExplorerImagePreviewResource(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WebAppResourceUrl> {
  const resource = await resolveFileExplorerResourcePath(target, path, "preview", options);
  return await appResourceUrl(resource.path, "resource", { signal: options?.signal });
}

export interface FileExplorerVideoPreviewResource {
  url: string;
  expiresAt: number | null;
}

async function resolveFileExplorerResourcePath(
  target: FileExplorerTarget,
  path: string,
  resource: "download" | "video-preview" | "preview",
  options?: WorkspaceFileRequestOptions,
): Promise<{ path: string }> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  return {
    path: `${getFileExplorerBasePath(target)}/${resource}?${searchParams.toString()}`,
  };
}

export async function saveFileExplorerFileApi(
  target: FileExplorerTarget,
  path: string,
  name: string,
  options?: WorkspaceFileRequestOptions,
): Promise<void> {
  const resource = await resolveFileExplorerResourcePath(target, path, "download", options);
  await appSaveResource(resource.path, { suggestedName: name, signal: options?.signal });
}

export async function getFileExplorerVideoPreviewUrl(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<FileExplorerVideoPreviewResource> {
  const resource = await resolveFileExplorerResourcePath(target, path, "video-preview", options);
  const authenticated = await appResourceUrl(resource.path, "resource", { signal: options?.signal });
  return {
    url: authenticated.url,
    expiresAt: authenticated.expiresAt,
  };
}

export async function downloadFileExplorerFileApi(
  target: FileExplorerTarget,
  path: string,
  options?: WorkspaceFileRequestOptions,
): Promise<Blob> {
  const searchParams = buildFileExplorerSearchParams(target, {
    path,
  }, options);
  return await requestFileExplorerBlob(
    `${getFileExplorerBasePath(target)}/download?${searchParams.toString()}`,
    buildFileExplorerRequestInit(options),
    "Download file explorer file",
  );
}

export async function writeFileExplorerFileApi(
  target: FileExplorerTarget,
  request: WriteFileExplorerRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileWriteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  const requestOptions = buildFileExplorerRequestInit(options, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...request,
      ...(startDirectory ? { startDirectory } : {}),
    }),
  });
  return await requestFileExplorer<WorkspaceFileWriteResponse>(
    `${getFileExplorerBasePath(target)}/write`,
    requestOptions,
    "Write file explorer file",
  );
}

export async function renameFileExplorerNodeApi(
  target: FileExplorerTarget,
  request: RenameFileExplorerRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileRenameResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  return await requestFileExplorer<WorkspaceFileRenameResponse>(
    `${getFileExplorerBasePath(target)}/rename`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        ...(startDirectory ? { startDirectory } : {}),
      }),
    }),
    "Rename file explorer node",
  );
}

export async function deleteFileExplorerNodeApi(
  target: FileExplorerTarget,
  request: DeleteFileExplorerRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileDeleteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  return await requestFileExplorer<WorkspaceFileDeleteResponse>(
    `${getFileExplorerBasePath(target)}/delete`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        ...(startDirectory ? { startDirectory } : {}),
      }),
    }),
    "Delete file explorer node",
  );
}

async function createFileExplorerUploadApi(
  target: FileExplorerTarget,
  request: CreateFileExplorerUploadRequest,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCreateResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  return await requestFileExplorer<WorkspaceFileUploadCreateResponse>(
    `${getFileExplorerBasePath(target)}/upload`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        ...(startDirectory ? { startDirectory } : {}),
      }),
    }),
    "Create file explorer upload",
  );
}

async function writeFileExplorerUploadChunkApi(
  target: FileExplorerTarget,
  uploadId: string,
  offset: number,
  chunk: Blob,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadChunkResponse> {
  const searchParams = buildFileExplorerSearchParams(target, {
    uploadId,
    offset: String(offset),
  }, options);
  return await requestFileExplorer<WorkspaceFileUploadChunkResponse>(
    `${getFileExplorerBasePath(target)}/upload/chunk?${searchParams.toString()}`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    }),
    "Upload file explorer chunk",
  );
}

async function completeFileExplorerUploadApi(
  target: FileExplorerTarget,
  uploadId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCompleteResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  return await requestFileExplorer<WorkspaceFileUploadCompleteResponse>(
    `${getFileExplorerBasePath(target)}/upload/complete`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uploadId,
        ...(startDirectory ? { startDirectory } : {}),
      }),
    }),
    "Complete file explorer upload",
  );
}

async function cancelFileExplorerUploadApi(
  target: FileExplorerTarget,
  uploadId: string,
  options?: WorkspaceFileRequestOptions,
): Promise<WorkspaceFileUploadCancelResponse> {
  const startDirectory = options?.startDirectory ?? target.startDirectory;
  return await requestFileExplorer<WorkspaceFileUploadCancelResponse>(
    `${getFileExplorerBasePath(target)}/upload/cancel`,
    buildFileExplorerRequestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uploadId,
        ...(startDirectory ? { startDirectory } : {}),
      }),
    }),
    "Cancel file explorer upload",
  );
}

export async function uploadFileExplorerFileApi(
  target: FileExplorerTarget,
  directory: string,
  file: File,
  options?: UploadFileExplorerFileOptions,
): Promise<WorkspaceFileUploadCompleteResponse> {
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

  try {
    await uploadFileInChunks(
      file.size,
      (chunkOffset, endOffset) => file.slice(chunkOffset, endOffset),
      async (chunkOffset, chunk) => {
        const response = await retryFileUploadChunk(
          () => writeFileExplorerUploadChunkApi(target, session.uploadId, chunkOffset, chunk, {
            startDirectory,
            signal: options?.signal,
          }),
          { signal: options?.signal },
        );
        return {
          bytesWritten: response.bytesWritten,
          nextOffset: response.nextOffset,
        };
      },
      {
        chunkSizeBytes: options?.chunkSizeBytes,
        signal: options?.signal,
        onProgress: options?.onProgress,
      },
    );
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
  request: WriteFileExplorerRequest,
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
