import { useEffect, useState } from "react";
import { ErrorState, Modal, useToast } from "@pablozaiden/webapp/web";
import { Button } from "./common";

export interface ImageViewerModalImage {
  src: string;
  alt: string;
  title: string;
  mimeType?: string;
  description?: string;
}

const SVG_PREVIEW_BACKGROUND = {
  backgroundColor: "#fff",
  backgroundImage: "conic-gradient(#d1d5db 25%, #fff 0 50%, #d1d5db 0 75%, #fff 0)",
  backgroundSize: "16px 16px",
};

interface ImageViewerModalProps {
  image: ImageViewerModalImage | null;
  onClose: () => void;
  loading?: boolean;
  title?: string;
}

interface ImageOpenState {
  src: string;
  blob: Blob | null;
  error: string | null;
}

function openImageWindow(blob: Blob, image: ImageViewerModalImage): void {
  const imageWindow = window.open("about:blank", "_blank");
  if (!imageWindow) {
    throw new Error("Allow pop-ups to open the image in a new tab.");
  }

  try {
    imageWindow.opener = null;
    const imageDocument = imageWindow.document;
    imageDocument.title = image.title;
    const viewport = imageDocument.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    imageDocument.head.appendChild(viewport);
    imageDocument.body.style.cssText = "margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #111;";
    if (image.mimeType === "image/svg+xml") {
      Object.assign(imageDocument.body.style, SVG_PREVIEW_BACKGROUND);
    }

    const standaloneImage = imageDocument.createElement("img");
    standaloneImage.alt = image.alt;
    standaloneImage.style.cssText = "display: block; max-width: 100%; max-height: 100vh; object-fit: contain;";
    // The new document owns the URL until it closes; <img> also keeps SVG scripts inert.
    const imageUrl = (imageWindow as Window & Pick<typeof globalThis, "URL">).URL.createObjectURL(blob);
    standaloneImage.src = imageUrl;
    imageDocument.body.replaceChildren(standaloneImage);
  } catch (error: unknown) {
    imageWindow.close();
    throw error;
  }
}

export function ImageViewerModal({
  image,
  onClose,
  loading = false,
  title,
}: ImageViewerModalProps) {
  const toast = useToast();
  const [openState, setOpenState] = useState<ImageOpenState | null>(null);
  const src = image?.src;
  const currentOpenState = openState?.src === src ? openState : null;

  useEffect(() => {
    setOpenState(null);
    if (!src) {
      return;
    }

    const controller = new AbortController();
    // Prepare bytes before the click so opening a tab remains a synchronous user action.
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Could not load image (HTTP ${response.status}).`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted) {
          return;
        }
        setOpenState({ src, blob, error: null });
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setOpenState({
            src,
            blob: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [src]);

  return (
    <Modal
      isOpen={image !== null || loading}
      onClose={onClose}
      title={title ?? image?.title ?? "Image preview"}
      size="xl"
      footer={(
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    >
      {loading ? (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          <span>Loading image preview...</span>
        </div>
      ) : image && (
        <div className="space-y-3">
          <div
            className="flex items-center justify-center rounded-lg bg-neutral-950 p-2 sm:p-4"
            style={image.mimeType === "image/svg+xml" ? SVG_PREVIEW_BACKGROUND : undefined}
          >
            <button
              type="button"
              disabled={!currentOpenState?.blob}
              onClick={() => {
                if (!currentOpenState?.blob) {
                  return;
                }
                try {
                  openImageWindow(currentOpenState.blob, image);
                } catch (error: unknown) {
                  toast.error(error instanceof Error ? error.message : String(error));
                }
              }}
              aria-label={`Open ${image.title} in a new tab`}
              aria-busy={!currentOpenState}
              title="Open image in a new tab"
              className="inline-flex max-w-full cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:cursor-default dark:focus-visible:ring-gray-500"
            >
              <img
                src={image.src}
                alt={image.alt}
                className="max-h-[70vh] w-auto max-w-full rounded object-contain"
              />
            </button>
          </div>
          {currentOpenState?.error && (
            <ErrorState title="Could not open image" description={currentOpenState.error} />
          )}
          {image.description && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {image.description}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
