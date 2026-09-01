/**
 * Shared defaults for streamed file uploads.
 */

export const FILE_UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const FILE_UPLOAD_MAX_CHUNK_ATTEMPTS = 3;

export interface FileUploadChunkResult {
  bytesWritten: number;
  nextOffset: number;
}

export interface FileUploadProgress {
  bytesUploaded: number;
  totalBytes: number;
}

function createUploadAbortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export async function retryFileUploadChunk<T>(
  upload: () => Promise<T>,
  options?: {
    signal?: AbortSignal;
    attempts?: number;
  },
): Promise<T> {
  const attempts = options?.attempts ?? FILE_UPLOAD_MAX_CHUNK_ATTEMPTS;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options?.signal?.aborted) {
      throw createUploadAbortError(options.signal);
    }
    try {
      return await upload();
    } catch (error) {
      lastError = error;
      if (options?.signal?.aborted || attempt === attempts) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function uploadFileInChunks(
  totalBytes: number,
  getChunk: (offset: number, endOffset: number) => Blob,
  sendChunk: (offset: number, chunk: Blob) => Promise<FileUploadChunkResult>,
  options?: {
    chunkSizeBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: FileUploadProgress) => void;
  },
): Promise<void> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("Upload size must be a non-negative safe integer");
  }
  const chunkSize = options?.chunkSizeBytes ?? FILE_UPLOAD_CHUNK_SIZE_BYTES;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Upload chunk size must be a positive safe integer");
  }

  let offset = 0;
  while (offset < totalBytes) {
    if (options?.signal?.aborted) {
      throw createUploadAbortError(options.signal);
    }
    const endOffset = Math.min(totalBytes, offset + chunkSize);
    const chunk = getChunk(offset, endOffset);
    if (chunk.size <= 0) {
      throw new Error("Upload source returned an empty chunk before completion");
    }
    const result = await sendChunk(offset, chunk);
    if (
      !Number.isSafeInteger(result.bytesWritten)
      || result.bytesWritten <= 0
      || result.bytesWritten > chunk.size
      || !Number.isSafeInteger(result.nextOffset)
      || result.nextOffset !== offset + result.bytesWritten
      || result.nextOffset > totalBytes
    ) {
      throw new Error("Upload chunk returned an invalid next offset");
    }
    offset = result.nextOffset;
    options?.onProgress?.({
      bytesUploaded: offset,
      totalBytes,
    });
  }
}
