import type { TranscriptSnapshotOptions } from "@/shared";
import { isDomainError } from "../domain/domain-error";
import { domainErrorResponse, errorResponse } from "./helpers";

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
