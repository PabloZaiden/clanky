/**
 * Browser-renderable image file detection for the file explorer.
 */

export const BROWSER_RENDERABLE_IMAGE_MIME_TYPES = [
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
] as const;

export type BrowserRenderableImageMimeType = typeof BROWSER_RENDERABLE_IMAGE_MIME_TYPES[number];

const IMAGE_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, BrowserRenderableImageMimeType>> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function getAsciiString(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function detectPngMimeType(bytes: Uint8Array): BrowserRenderableImageMimeType {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const chunkLength = (
      (bytes[offset]! << 24)
      | (bytes[offset + 1]! << 16)
      | (bytes[offset + 2]! << 8)
      | bytes[offset + 3]!
    ) >>> 0;
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > bytes.length) {
      break;
    }
    if (getAsciiString(bytes, offset + 4, 4) === "acTL") {
      return "image/apng";
    }
    if (getAsciiString(bytes, offset + 4, 4) === "IEND") {
      break;
    }
    offset = chunkEnd;
  }
  return "image/png";
}

function hasAvifSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || getAsciiString(bytes, 4, 4) !== "ftyp") {
    return false;
  }

  if (getAsciiString(bytes, 8, 4) === "avif" || getAsciiString(bytes, 8, 4) === "avis") {
    return true;
  }

  for (let offset = 16; offset + 4 <= bytes.length; offset += 4) {
    const compatibleBrand = getAsciiString(bytes, offset, 4);
    if (compatibleBrand === "avif" || compatibleBrand === "avis") {
      return true;
    }
  }
  return false;
}

function hasSvgSignature(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  const text = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text);
}

export function detectBrowserImageMimeType(
  bytes: Uint8Array,
): BrowserRenderableImageMimeType | null {
  if (hasPngSignature(bytes)) {
    return detectPngMimeType(bytes);
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = getAsciiString(bytes, 0, 6);
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 12
    && getAsciiString(bytes, 0, 4) === "RIFF"
    && getAsciiString(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  if (hasAvifSignature(bytes)) {
    return "image/avif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }
  if (hasSvgSignature(bytes)) {
    return "image/svg+xml";
  }
  return null;
}

export function getBrowserImageMimeType(path: string): BrowserRenderableImageMimeType | null {
  const normalizedPath = path.toLowerCase();
  const extension = Object.keys(IMAGE_MIME_TYPES_BY_EXTENSION)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedPath.endsWith(candidate));

  return extension ? IMAGE_MIME_TYPES_BY_EXTENSION[extension]! : null;
}

export function isBrowserRenderableImage(path: string): boolean {
  return getBrowserImageMimeType(path) !== null;
}
