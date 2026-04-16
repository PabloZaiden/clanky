import { Button, Modal } from "./common";

export interface ImageViewerModalImage {
  src: string;
  alt: string;
  title: string;
  description?: string;
}

interface ImageViewerModalProps {
  image: ImageViewerModalImage | null;
  onClose: () => void;
}

export function ImageViewerModal({ image, onClose }: ImageViewerModalProps) {
  return (
    <Modal
      isOpen={image !== null}
      onClose={onClose}
      title={image?.title ?? "Image preview"}
      size="xl"
      footer={(
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      )}
    >
      {image && (
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
