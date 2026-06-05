/**
 * Helpers for returning file download responses.
 */

import type { WorkspaceFileEntry } from "../types";

function sanitizeAttachmentFileName(fileName: string): string {
  return fileName.replace(/["\r\n]/g, "_") || "download";
}

function encodeAttachmentFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function createFileDownloadResponse(
  body: BodyInit,
  contentType: string,
  file: WorkspaceFileEntry,
  options?: { contentLength?: number },
): Response {
  const safeFileName = sanitizeAttachmentFileName(file.name);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeAttachmentFileName(file.name)}`,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (options?.contentLength !== undefined) {
    headers.set("Content-Length", String(options.contentLength));
  }
  return new Response(body, {
    headers,
  });
}
