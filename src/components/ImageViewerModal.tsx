import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "./common";

export interface ImageViewerModalImage {
  src: string;
  alt: string;
  title: string;
  description?: string;
}

interface ImageViewerModalProps {
  image: ImageViewerModalImage | null;
  onClose: () => void;
  loading?: boolean;
  title?: string;
}

export function ImageViewerModal({
  image,
  onClose,
  loading = false,
  title,
}: ImageViewerModalProps) {
  return (
    <Modal
      isOpen={image !== null || loading}
      onClose={onClose}
      title={title ?? image?.title ?? "Image preview"}
      size="xl"
      footer={(
        <div className="flex items-center justify-end gap-2">
          {image && !loading && (
            <a
              href={image.src}
              download={image.title}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200 dark:focus-visible:ring-gray-500"
            >
              Download
            </a>
          )}
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
          <div className="flex items-center justify-center rounded-lg bg-neutral-950 p-2 sm:p-4">
            <img
              src={image.src}
              alt={image.alt}
              className="max-h-[70vh] w-auto max-w-full rounded object-contain"
            />
          </div>
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
