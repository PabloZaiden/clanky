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
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
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
