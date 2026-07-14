/**
 * Helpers for returning file download responses.
 */

import type { WorkspaceFileEntry } from "@/shared";

function sanitizeAttachmentFileName(fileName: string): string {
  return fileName.replace(/["\r\n]/g, "_") || "download";
}

function sanitizeInlineFileName(fileName: string): string {
  return fileName.replace(/["\r\n]/g, "_") || "image";
}

function encodeAttachmentFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function createFileDownloadHeaders(
  contentType: string,
  file: WorkspaceFileEntry,
  options?: { contentLength?: number },
): Headers {
  const safeFileName = sanitizeAttachmentFileName(file.name);
  const headers = new Headers({
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, X-Clanky-Download-Size",
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeAttachmentFileName(file.name)}`,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (options?.contentLength !== undefined) {
    const contentLength = String(options.contentLength);
    headers.set("Content-Length", contentLength);
    headers.set("X-Clanky-Download-Size", contentLength);
  }
  return headers;
}

export function createFileDownloadResponse(
  body: BodyInit,
  contentType: string,
  file: WorkspaceFileEntry,
  options?: { contentLength?: number },
): Response {
  const headers = createFileDownloadHeaders(contentType, file, options);
  return new Response(body, {
    headers,
  });
}

export function createInlineImageResponse(
  data: Uint8Array,
  contentType: string,
  fileName: string,
): Response {
  const body = new ArrayBuffer(data.byteLength);
  new Uint8Array(body).set(data);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${sanitizeInlineFileName(fileName)}"`,
      "Content-Type": contentType,
    },
  });
}

export function createFileDownloadHeadResponse(
  contentType: string,
  file: WorkspaceFileEntry,
  options?: { contentLength?: number },
): Response {
  const headers = createFileDownloadHeaders(contentType, file, options);
  return new Response(null, {
    headers,
  });
}
