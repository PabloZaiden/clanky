/**
 * Versioned, user-bound transcript pagination cursors.
 *
 * Cursor input is untrusted persisted request data and is accepted only after
 * validating its shape and binding to the requested resource, ID, and user.
 */
import { DomainError } from "../../domain/domain-error";
import type {
  TranscriptCursor,
  TranscriptResource,
  TranscriptResponseRow,
} from "./types";

const MAX_TRANSCRIPT_CURSOR_LENGTH = 2048;

export class TranscriptCursorError extends DomainError<"transcript_cursor_invalid"> {
  constructor(message: string) {
    super("transcript_cursor_invalid", message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTranscriptCursor(
  value: unknown,
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
): value is TranscriptCursor {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["version"] === 1
    && value["resource"] === resource
    && value["resourceId"] === resourceId
    && value["userId"] === userId
    && typeof value["entryId"] === "string"
    && value["entryId"].startsWith("message:")
    && typeof value["timestamp"] === "string"
    && typeof value["sequence"] === "number"
    && Number.isInteger(value["sequence"])
    && value["sequence"] >= 0
  );
}

export function encodeTranscriptCursor(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  row: TranscriptResponseRow,
): string {
  const cursor: TranscriptCursor = {
    version: 1,
    resource,
    resourceId,
    userId,
    entryId: row.entry_id,
    timestamp: row.timestamp,
    sequence: row.sequence,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTranscriptCursor(
  resource: TranscriptResource,
  resourceId: string,
  userId: string,
  encoded: string,
): TranscriptCursor {
  if (encoded.length > MAX_TRANSCRIPT_CURSOR_LENGTH) {
    throw new TranscriptCursorError("Transcript cursor is too long");
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (!isTranscriptCursor(parsed, resource, resourceId, userId)) {
      throw new TranscriptCursorError("Transcript cursor is invalid");
    }
    return parsed;
  } catch (error) {
    if (error instanceof TranscriptCursorError) {
      throw error;
    }
    throw new TranscriptCursorError("Transcript cursor is invalid");
  }
}
