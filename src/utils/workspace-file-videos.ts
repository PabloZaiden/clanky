/**
 * Browser-renderable video file detection for the file explorer.
 */

export type BrowserRenderableVideoMimeType = "video/mp4" | "video/webm";

const VIDEO_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, BrowserRenderableVideoMimeType>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
};

export function getBrowserVideoMimeType(path: string): BrowserRenderableVideoMimeType | null {
  const normalizedPath = path.toLowerCase();
  const extension = Object.keys(VIDEO_MIME_TYPES_BY_EXTENSION)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedPath.endsWith(candidate));

  return extension ? VIDEO_MIME_TYPES_BY_EXTENSION[extension]! : null;
}
