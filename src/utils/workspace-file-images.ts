/**
 * Browser-renderable image file detection for the file explorer.
 */

const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".svgz": "image/svg+xml",
  ".webp": "image/webp",
};

export function getBrowserImageMimeType(path: string): string | null {
  const normalizedPath = path.toLowerCase();
  const extension = Object.keys(IMAGE_MIME_TYPES_BY_EXTENSION)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedPath.endsWith(candidate));

  return extension ? IMAGE_MIME_TYPES_BY_EXTENSION[extension]! : null;
}

export function isBrowserRenderableImage(path: string): boolean {
  return getBrowserImageMimeType(path) !== null;
}
