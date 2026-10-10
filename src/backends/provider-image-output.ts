import { createHash } from "node:crypto";
import type { HarnessEventPayload } from "@/shared/harness-events";
import {
  getBase64DecodedByteLength,
  MESSAGE_ATTACHMENT_LIMIT,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_TURN_BYTES,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  type MessageAttachment,
} from "@/shared/message-attachments";
import { detectBrowserImageMimeType } from "../utils/workspace-file-images";

const MAX_IMAGE_CANDIDATES = 32;
const MAX_OUTPUT_DEPTH = 16;
const MAX_OUTPUT_NODES = 2_048;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MESSAGE_ATTACHMENT_MAX_BYTES / 3) * 4;
const MAX_IMAGE_BASE64_WHITESPACE_LENGTH = 1024 * 1024;
const MAX_IMAGE_DATA_URI_HEADER_LENGTH = 128;
const IMAGE_MIME_TYPES: readonly string[] = MESSAGE_IMAGE_ALLOWED_MIME_TYPES;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const OMIT_IMAGE_PAYLOAD = Symbol("omit-image-payload");

type ImageCandidate = {
  data: string;
};

type CandidateCollection = {
  candidates: ImageCandidate[];
  rejectedImageCount: number;
  truncated: boolean;
  nodeCount: number;
  seen: WeakSet<object>;
};

type SanitizationState = {
  nodeCount: number;
  seen: WeakSet<object>;
};

export interface ProviderImageOutputProjection {
  output: unknown;
  events: HarnessEventPayload[];
  rejectedImageCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInlineImageDataUri(value: string): boolean {
  return /^data:image\//i.test(value);
}

function parseInlineImageDataUri(value: string): ImageCandidate | null {
  const comma = value.indexOf(",");
  if (comma < 0 || !isInlineImageDataUri(value)) {
    return null;
  }

  const metadata = value.slice(5, comma).split(";");
  const mimeType = metadata[0];
  if (
    !mimeType?.toLowerCase().startsWith("image/")
    || !metadata.slice(1).some((parameter) => parameter.toLowerCase() === "base64")
  ) {
    return null;
  }

  return {
    data: value.slice(comma + 1),
  };
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === "string"
    && value.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") === true;
}

function isImagePayloadRecord(value: Record<string, unknown>): boolean {
  const type = typeof value["type"] === "string" ? value["type"].toLowerCase() : "";
  if (
    type === "image"
    || type === "image_url"
    || type === "imagegeneration"
    || type === "image_generation_call"
    || type === "output_image"
  ) {
    return true;
  }
  return isImageMimeType(value["mimeType"])
    && (typeof value["data"] === "string" || typeof value["url"] === "string");
}

function addImageCandidate(
  candidate: ImageCandidate,
  collection: CandidateCollection,
): void {
  if (collection.candidates.length >= MAX_IMAGE_CANDIDATES) {
    collection.truncated = true;
    return;
  }
  collection.candidates.push(candidate);
}

function collectImageCandidates(
  value: unknown,
  collection: CandidateCollection,
  depth = 0,
): void {
  if (collection.nodeCount >= MAX_OUTPUT_NODES || depth > MAX_OUTPUT_DEPTH) {
    collection.truncated = true;
    return;
  }
  collection.nodeCount += 1;

  if (typeof value === "string") {
    if (isInlineImageDataUri(value)) {
      addImageCandidate({ data: value }, collection);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (collection.nodeCount >= MAX_OUTPUT_NODES) {
        collection.truncated = true;
        break;
      }
      collectImageCandidates(entry, collection, depth + 1);
    }
    return;
  }

  if (!isRecord(value) || collection.seen.has(value)) {
    return;
  }
  collection.seen.add(value);

  const type = typeof value["type"] === "string" ? value["type"].toLowerCase() : "";
  if (type === "image" || type === "image_url") {
    const imageUrl = isRecord(value["image_url"]) ? value["image_url"] : undefined;
    const data = typeof value["data"] === "string"
      ? value["data"]
      : typeof value["url"] === "string" && isInlineImageDataUri(value["url"])
        ? value["url"]
        : typeof imageUrl?.["url"] === "string" && isInlineImageDataUri(imageUrl["url"])
          ? imageUrl["url"]
          : undefined;
    if (data !== undefined) {
      addImageCandidate({ data }, collection);
    } else {
      collection.rejectedImageCount += 1;
    }
    return;
  }

  if (type === "imagegeneration" || type === "image_generation_call" || type === "output_image") {
    const data = typeof value["result"] === "string"
      ? value["result"]
      : typeof value["data"] === "string"
        ? value["data"]
        : undefined;
    if (data !== undefined) {
      addImageCandidate({ data }, collection);
    } else {
      collection.rejectedImageCount += 1;
    }
    return;
  }

  if (
    typeof value["data"] === "string"
    && (isImageMimeType(value["mimeType"]) || isInlineImageDataUri(value["data"]))
  ) {
    addImageCandidate({ data: value["data"] }, collection);
    return;
  }

  if (isImageMimeType(value["mimeType"]) && typeof value["url"] === "string") {
    if (isInlineImageDataUri(value["url"])) {
      addImageCandidate({ data: value["url"] }, collection);
    } else {
      collection.rejectedImageCount += 1;
    }
    return;
  }

  if (
    isImageMimeType(value["mimeType"])
    && isRecord(value["image_url"])
    && typeof value["image_url"]["url"] === "string"
  ) {
    const url = value["image_url"]["url"];
    if (isInlineImageDataUri(url)) {
      addImageCandidate({ data: url }, collection);
    } else {
      collection.rejectedImageCount += 1;
    }
    return;
  }

  for (const key of ["content", "contentItems", "parts", "items", "output", "result", "images"]) {
    if (key in value) {
      collectImageCandidates(value[key], collection, depth + 1);
    }
  }
}

function sanitizeImagePayloads(
  value: unknown,
  state: SanitizationState,
  depth = 0,
): unknown | typeof OMIT_IMAGE_PAYLOAD {
  if (state.nodeCount >= MAX_OUTPUT_NODES || depth > MAX_OUTPUT_DEPTH) {
    return OMIT_IMAGE_PAYLOAD;
  }
  state.nodeCount += 1;
  if (typeof value === "string") {
    return isInlineImageDataUri(value) ? OMIT_IMAGE_PAYLOAD : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (state.seen.has(value)) {
    return OMIT_IMAGE_PAYLOAD;
  }
  state.seen.add(value);

  if (isRecord(value) && isImagePayloadRecord(value)) {
    return OMIT_IMAGE_PAYLOAD;
  }
  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    for (const entry of value) {
      if (state.nodeCount >= MAX_OUTPUT_NODES) {
        break;
      }
      const sanitizedEntry = sanitizeImagePayloads(entry, state, depth + 1);
      if (sanitizedEntry !== OMIT_IMAGE_PAYLOAD) {
        sanitized.push(sanitizedEntry);
      }
    }
    return sanitized;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (state.nodeCount >= MAX_OUTPUT_NODES) {
      break;
    }
    const sanitizedChild = sanitizeImagePayloads(child, state, depth + 1);
    if (sanitizedChild !== OMIT_IMAGE_PAYLOAD) {
      sanitized[key] = sanitizedChild;
    }
  }
  if (
    Object.keys(sanitized).length === 0
    || (sanitized["type"] === "content" && Object.keys(sanitized).length === 1)
  ) {
    return OMIT_IMAGE_PAYLOAD;
  }
  return sanitized;
}

export function redactProviderImagePayloads(value: unknown): unknown {
  const collection: CandidateCollection = {
    candidates: [],
    rejectedImageCount: 0,
    truncated: false,
    nodeCount: 0,
    seen: new WeakSet(),
  };
  collectImageCandidates(value, collection);
  if (collection.candidates.length === 0 && collection.rejectedImageCount === 0) {
    return value;
  }
  return redactCollectedProviderImagePayloads(value);
}

function redactCollectedProviderImagePayloads(value: unknown): unknown {
  const sanitized = sanitizeImagePayloads(value, { nodeCount: 0, seen: new WeakSet() });
  return sanitized === OMIT_IMAGE_PAYLOAD ? null : sanitized;
}

function stableOutputId(prefix: string, sourceId: string, index: number): string {
  const digest = createHash("sha256")
    .update(sourceId.slice(0, 2_048))
    .update("\0")
    .update(String(index))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function decodeImageAttachment(
  candidate: ImageCandidate,
  sourceId: string,
  candidateIndex: number,
  remainingTurnBytes: number,
): MessageAttachment | null {
  if (
    candidate.data.length
    > MAX_IMAGE_BASE64_LENGTH
      + MAX_IMAGE_BASE64_WHITESPACE_LENGTH
      + MAX_IMAGE_DATA_URI_HEADER_LENGTH
  ) {
    return null;
  }
  const inlineData = parseInlineImageDataUri(candidate.data);
  const rawBase64 = inlineData?.data ?? candidate.data;
  if (rawBase64.length > MAX_IMAGE_BASE64_LENGTH + MAX_IMAGE_BASE64_WHITESPACE_LENGTH) {
    return null;
  }
  const base64 = rawBase64.replace(/\s/g, "");
  if (
    base64.length === 0
    || base64.length > MAX_IMAGE_BASE64_LENGTH
    || base64.length % 4 === 1
    || (base64.includes("=") && base64.length % 4 !== 0)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  ) {
    return null;
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const unpaddedLength = base64.length - padding;
  const remainder = unpaddedLength % 4;
  const lastBase64Value = BASE64_ALPHABET.indexOf(base64[unpaddedLength - 1] ?? "");
  if (
    (padding === 2 && remainder !== 2)
    || (padding === 1 && remainder !== 3)
    || (remainder === 2 && (lastBase64Value & 0b1111) !== 0)
    || (remainder === 3 && (lastBase64Value & 0b11) !== 0)
  ) {
    return null;
  }

  const size = getBase64DecodedByteLength(base64);
  if (
    size === 0
    || size > MESSAGE_ATTACHMENT_MAX_BYTES
    || size > remainingTurnBytes
  ) {
    return null;
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== size) {
    return null;
  }

  const mimeType = detectBrowserImageMimeType(bytes);
  if (!mimeType || !IMAGE_MIME_TYPES.includes(mimeType)) {
    return null;
  }

  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return {
    id: stableOutputId("provider-image", sourceId, candidateIndex),
    filename: `generated-image-${candidateIndex + 1}.${extension}`,
    mimeType,
    data: base64,
    size,
  };
}

function buildOmissionWarning(count: number): HarnessEventPayload {
  const subject = count === 1
    ? "A provider-generated image was"
    : `${String(count)} provider-generated images were`;
  const reason = count === 1
    ? "its format or size is unsupported"
    : "their format or size is unsupported";
  return {
    type: "request.error",
    code: "provider_image_omitted",
    message: `${subject} omitted because ${reason}.`,
  };
}

export function projectProviderImageOutput(
  value: unknown,
  sourceId: string,
): ProviderImageOutputProjection {
  const collection: CandidateCollection = {
    candidates: [],
    rejectedImageCount: 0,
    truncated: false,
    nodeCount: 0,
    seen: new WeakSet(),
  };
  collectImageCandidates(value, collection);

  const events: HarnessEventPayload[] = [];
  let attachmentCount = 0;
  let totalBytes = 0;
  for (const [candidateIndex, candidate] of collection.candidates.entries()) {
    if (
      attachmentCount >= MESSAGE_ATTACHMENT_LIMIT
      || totalBytes >= MESSAGE_ATTACHMENT_MAX_TURN_BYTES
    ) {
      collection.rejectedImageCount += 1;
      continue;
    }
    const attachment = decodeImageAttachment(
      candidate,
      sourceId,
      candidateIndex,
      MESSAGE_ATTACHMENT_MAX_TURN_BYTES - totalBytes,
    );
    if (!attachment) {
      collection.rejectedImageCount += 1;
      continue;
    }
    attachmentCount += 1;
    totalBytes += attachment.size;
    const messageId = stableOutputId(
      "provider-image-message",
      sourceId,
      candidateIndex,
    );
    events.push({ type: "message.start", messageId });
    events.push({
      type: "message.complete",
      messageId,
      content: "",
      attachments: [attachment],
    });
  }
  if (
    collection.truncated
    && (collection.candidates.length > 0 || collection.rejectedImageCount > 0)
  ) {
    collection.rejectedImageCount += 1;
  }

  if (collection.rejectedImageCount > 0) {
    events.push(buildOmissionWarning(collection.rejectedImageCount));
  }

  return {
    output: collection.candidates.length > 0 || collection.rejectedImageCount > 0
      ? redactCollectedProviderImagePayloads(value)
      : value,
    events,
    rejectedImageCount: collection.rejectedImageCount,
  };
}
