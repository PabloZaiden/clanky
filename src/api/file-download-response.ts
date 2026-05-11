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
  data: Uint8Array,
  contentType: string,
  file: WorkspaceFileEntry,
): Response {
  const safeFileName = sanitizeAttachmentFileName(file.name);
  const body = new ArrayBuffer(data.byteLength);
  new Uint8Array(body).set(data);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeAttachmentFileName(file.name)}`,
      "Content-Length": String(data.byteLength),
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
