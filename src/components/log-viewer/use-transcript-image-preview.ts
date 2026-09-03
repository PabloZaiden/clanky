import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "@pablozaiden/webapp/web";
import type { WorkspaceFileEntry } from "@/shared";
import { readFileExplorerImagePreviewApi } from "../../hooks/workspaceFileActions";
import type { ImageViewerModalImage } from "../ImageViewerModal";
import type { TranscriptFileLinkContext, TranscriptFileLinkTarget } from "./types";

const log = createLogger("transcript-image-preview");

interface PendingImagePreview {
  title: string;
}

export interface TranscriptImagePreviewState {
  image: ImageViewerModalImage | null;
  loading: boolean;
  title: string;
  openImagePreview: (target: TranscriptFileLinkTarget, file: WorkspaceFileEntry) => void;
  closeImagePreview: () => void;
}

function getImageTitle(target: TranscriptFileLinkTarget, file: WorkspaceFileEntry): string {
  return file.name || target.path || "Image preview";
}

function getImageDescription(target: TranscriptFileLinkTarget, file: WorkspaceFileEntry): string {
  const displayPath = target.kind === "directory" ? target.startDirectory : target.path;
  const sizeInKilobytes = Math.max(1, Math.round(file.size / 1024));
  return `${displayPath} - ${sizeInKilobytes} KB`;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof Error && error.name === "AbortError")
    || (error instanceof DOMException && error.name === "AbortError");
}

export function useTranscriptImagePreview(
  fileLinkContext?: TranscriptFileLinkContext,
): TranscriptImagePreviewState {
  const [image, setImage] = useState<ImageViewerModalImage | null>(null);
  const [pendingPreview, setPendingPreview] = useState<PendingImagePreview | null>(null);
  const requestIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const previousContextKeyRef = useRef<string | null>(null);

  const revokeObjectUrl = useCallback(() => {
    if (!objectUrlRef.current) {
      return;
    }
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const cancelImageLoad = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    requestIdRef.current += 1;
    revokeObjectUrl();
  }, [revokeObjectUrl]);

  const closeImagePreview = useCallback(() => {
    cancelImageLoad();
    setImage(null);
    setPendingPreview(null);
  }, [cancelImageLoad]);

  const openImagePreview = useCallback((
    target: TranscriptFileLinkTarget,
    file: WorkspaceFileEntry,
  ) => {
    if (!fileLinkContext) {
      return;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    revokeObjectUrl();

    const title = getImageTitle(target, file);
    const onFileOpenError = fileLinkContext.onFileOpenError;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setImage(null);
    setPendingPreview({ title });

    void (async () => {
      try {
        const imageBlob = await readFileExplorerImagePreviewApi(
          fileLinkContext.fileExplorerTarget,
          target.path,
          {
            startDirectory: target.startDirectory,
            signal: abortController.signal,
          },
        );
        if (abortController.signal.aborted || requestIdRef.current !== requestId) {
          return;
        }

        const objectUrl = URL.createObjectURL(imageBlob);
        objectUrlRef.current = objectUrl;
        setImage({
          src: objectUrl,
          alt: file.name || title,
          title,
          description: getImageDescription(target, file),
        });
        setPendingPreview(null);
      } catch (error: unknown) {
        if (isAbortError(error, abortController.signal) || requestIdRef.current !== requestId) {
          return;
        }

        setImage(null);
        setPendingPreview(null);
        const message = error instanceof Error ? error.message : String(error);
        const fallbackMessage = message || `Could not preview "${target.path}".`;
        if (onFileOpenError) {
          onFileOpenError(fallbackMessage);
        } else {
          log.warn(fallbackMessage);
        }
      } finally {
        if (requestIdRef.current === requestId && abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    })();
  }, [fileLinkContext, revokeObjectUrl]);

  const previewContextKey = fileLinkContext
    ? [
        fileLinkContext.fileExplorerTarget.type,
        fileLinkContext.fileExplorerTarget.id,
        fileLinkContext.fileExplorerTarget.startDirectory ?? "",
        fileLinkContext.rootDirectory,
      ].join("\u0000")
    : null;

  useEffect(() => {
    const previousContextKey = previousContextKeyRef.current;
    previousContextKeyRef.current = previewContextKey;
    if (previousContextKey !== null && previousContextKey !== previewContextKey) {
      setImage(null);
      setPendingPreview(null);
    }

    return cancelImageLoad;
  }, [cancelImageLoad, previewContextKey]);

  return {
    image,
    loading: pendingPreview !== null,
    title: pendingPreview?.title ?? image?.title ?? "Image preview",
    openImagePreview,
    closeImagePreview,
  };
}
