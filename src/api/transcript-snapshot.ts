import type { TranscriptSnapshotOptions } from "@/shared";
import { isDomainError } from "../core/domain-error";
import { errorResponse } from "./helpers";

export function parseTranscriptSnapshotOptions(
  request: Request,
): TranscriptSnapshotOptions | Response {
  const search = new URL(request.url).searchParams;
  const full = search.get("full");
  const before = search.get("before");

  if (full !== null && full !== "1") {
    return errorResponse(
      "invalid_transcript_options",
      "The full transcript option must be 1",
      400,
    );
  }
  if (before !== null && before.length === 0) {
    return errorResponse(
      "invalid_transcript_options",
      "The transcript cursor must not be empty",
      400,
    );
  }
  if (full === "1" && before !== null) {
    return errorResponse(
      "invalid_transcript_options",
      "The full transcript option cannot be combined with a cursor",
      400,
    );
  }
  if (before !== null && before.length > 2048) {
    return errorResponse(
      "invalid_transcript_options",
      "The transcript cursor is too long",
      400,
    );
  }

  return {
    ...(full === "1" ? { full: true } : {}),
    ...(before !== null ? { before } : {}),
  };
}

export function transcriptSnapshotErrorResponse(error: unknown): Response | null {
  if (!isDomainError(error) || error.code !== "transcript_cursor_invalid") {
    return null;
  }
  return errorResponse(
    "invalid_transcript_cursor",
    "The transcript cursor is invalid",
    400,
  );
}
