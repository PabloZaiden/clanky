import { createHash } from "node:crypto";
import { getCanonicalMessageAttachmentMimeType, getMessageAttachmentKind, type MessageAttachment, type TranscriptSnapshotOptions } from "@/shared";
import { isDomainError } from "../domain/domain-error";
import { domainErrorResponse, errorResponse } from "./helpers";
import { createFileDownloadResponse } from "./file-download-response";

export function transcriptAttachmentResponse(request: Request, attachment: MessageAttachment | null): Response {
  if (!attachment) return errorResponse("not_found", "Attachment not found", 404);
  if (getMessageAttachmentKind(attachment) === "file") {
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.byteLength !== attachment.size) throw new Error("The saved attachment is incomplete.");
    return createFileDownloadResponse(bytes, "application/octet-stream", { name: attachment.filename }, {
      contentLength: bytes.byteLength,
    });
  }
  const etag = `"${createHash("sha256").update(attachment.data).digest("hex")}"`;
  const headers = {
    "Cache-Control": "private, no-cache",
    "Content-Type": getCanonicalMessageAttachmentMimeType(attachment),
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  };
  return request.headers.get("If-None-Match") === etag
    ? new Response(null, { status: 304, headers })
    : new Response(Buffer.from(attachment.data, "base64"), { headers });
}

/**
 * Parse the paged transcript contract. An omitted option returns only the
 * latest response page; callers that need every persisted entry must request
 * `full=1`, while `before` loads older history and `since` refreshes an
 * explicitly loaded window from its oldest response cursor.
 */
export function parseTranscriptSnapshotOptions(
  request: Request,
): TranscriptSnapshotOptions | Response {
  const search = new URL(request.url).searchParams;
  const full = search.get("full");
  const before = search.get("before");
  const since = search.get("since");

  if (full !== null && full !== "1") {
    return errorResponse(
      "invalid_transcript_options",
      "The full transcript option must be 1",
      400,
    );
  }
  if ([before, since].some((cursor) => cursor !== null && cursor.length === 0)) {
    return errorResponse(
      "invalid_transcript_options",
      "The transcript cursor must not be empty",
      400,
    );
  }
  if ([full === "1", before !== null, since !== null].filter(Boolean).length > 1) {
    return errorResponse(
      "invalid_transcript_options",
      "Transcript window options cannot be combined",
      400,
    );
  }
  if ([before, since].some((cursor) => cursor !== null && cursor.length > 2048)) {
    return errorResponse(
      "invalid_transcript_options",
      "The transcript cursor is too long",
      400,
    );
  }

  return {
    ...(full === "1" ? { full: true } : {}),
    ...(before !== null ? { before } : {}),
    ...(since !== null ? { since } : {}),
  };
}

export function transcriptSnapshotErrorResponse(error: unknown): Response | null {
  if (!isDomainError(error) || error.code !== "transcript_cursor_invalid") {
    return null;
  }
  return domainErrorResponse(error, {
    policy: "transcript",
    fallback: {
      error: "invalid_transcript_cursor",
      message: "The transcript cursor is invalid",
      status: 400,
    },
  });
}
