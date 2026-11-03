import { createHash } from "node:crypto";
import type { HarnessEventPayload } from "@/shared/harness-events";
import {
  getBase64DecodedByteLength,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  type MessageAttachment,
} from "@/shared/message-attachments";
import { detectBrowserImageMimeType } from "../utils/workspace-file-images";

const IMAGE_MIME_TYPES: readonly string[] = MESSAGE_IMAGE_ALLOWED_MIME_TYPES;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const OMIT_IMAGE_PAYLOAD = Symbol("omit-image-payload");

type ImageCandidate = {
  data: string;
};

type CandidateCollection = {
  candidates: ImageCandidate[];
  rejectedImageCount: number;
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
    || type === "inputimage"
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
  collection.candidates.push(candidate);
}

function collectImageCandidates(
  value: unknown,
  collection: CandidateCollection,
): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (isInlineImageDataUri(current)) addImageCandidate({ data: current }, collection);
      continue;
    }
    if (current === null || typeof current !== "object" || collection.seen.has(current)) continue;
    collection.seen.add(current);
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) pending.push(current[index]);
      continue;
    }
    if (!isRecord(current)) continue;

    const type = typeof current["type"] === "string" ? current["type"].toLowerCase() : "";
    if (type === "image" || type === "image_url" || type === "inputimage") {
      const imageUrl = isRecord(current["image_url"]) ? current["image_url"] : undefined;
      const data = typeof current["data"] === "string"
        ? current["data"]
        : typeof current["url"] === "string" && isInlineImageDataUri(current["url"])
          ? current["url"]
          : typeof imageUrl?.["url"] === "string" && isInlineImageDataUri(imageUrl["url"])
            ? imageUrl["url"]
            : typeof current["imageUrl"] === "string" && isInlineImageDataUri(current["imageUrl"])
              ? current["imageUrl"]
              : undefined;
      if (data !== undefined) addImageCandidate({ data }, collection);
      else collection.rejectedImageCount += 1;
      continue;
    }
    if (type === "imagegeneration" || type === "image_generation_call" || type === "output_image") {
      const data = typeof current["result"] === "string"
        ? current["result"]
        : typeof current["data"] === "string" ? current["data"] : undefined;
      if (data !== undefined) addImageCandidate({ data }, collection);
      else collection.rejectedImageCount += 1;
      continue;
    }
    if (typeof current["data"] === "string"
      && (isImageMimeType(current["mimeType"]) || isInlineImageDataUri(current["data"]))) {
      addImageCandidate({ data: current["data"] }, collection);
      continue;
    }
    const imageUrl = isRecord(current["image_url"]) ? current["image_url"]["url"] : undefined;
    const url = typeof current["url"] === "string" ? current["url"] : imageUrl;
    if (isImageMimeType(current["mimeType"]) && typeof url === "string") {
      if (isInlineImageDataUri(url)) addImageCandidate({ data: url }, collection);
      else collection.rejectedImageCount += 1;
      continue;
    }
    const keys = [
      "attachments", "content", "contents", "contentItems", "binaryResultsForLlm",
      "images", "items", "output", "parts", "result", "toolOutput", "update",
    ];
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      if (key in current) pending.push(current[key]);
    }
  }
}

function sanitizeImagePayloads(value: unknown): unknown | typeof OMIT_IMAGE_PAYLOAD {
  type Sanitized = unknown | typeof OMIT_IMAGE_PAYLOAD;
  type Job = { value: unknown; write: (result: Sanitized) => void } | { finish: () => void };
  let result: Sanitized = OMIT_IMAGE_PAYLOAD;
  const pending: Job[] = [{ value, write: (value) => { result = value; } }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const job = pending.pop()!;
    if ("finish" in job) {
      job.finish();
      continue;
    }
    const current = job.value;
    if (typeof current === "string") {
      job.write(isInlineImageDataUri(current) ? OMIT_IMAGE_PAYLOAD : current);
      continue;
    }
    if (current === null || typeof current !== "object") {
      job.write(current);
      continue;
    }
    if (seen.has(current) || (isRecord(current) && isImagePayloadRecord(current))) {
      job.write(OMIT_IMAGE_PAYLOAD);
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      const sanitized: unknown[] = [];
      pending.push({ finish: () => job.write(sanitized) });
      for (let index = current.length - 1; index >= 0; index--) {
        pending.push({ value: current[index], write: (value) => {
          if (value !== OMIT_IMAGE_PAYLOAD) sanitized.push(value);
        } });
      }
      continue;
    }
    const sanitized: Record<string, unknown> = {};
    pending.push({ finish: () => {
      const keys = Object.keys(sanitized);
      job.write(keys.length === 0 || (sanitized["type"] === "content" && keys.length === 1)
        ? OMIT_IMAGE_PAYLOAD : sanitized);
    } });
    const entries = Object.entries(current);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      pending.push({ value: child, write: (value) => {
        if (value !== OMIT_IMAGE_PAYLOAD) sanitized[key] = value;
      } });
    }
  }
  return result;
}

export function redactProviderImagePayloads(value: unknown): unknown {
  const collection: CandidateCollection = {
    candidates: [],
    rejectedImageCount: 0,
    seen: new WeakSet(),
  };
  collectImageCandidates(value, collection);
  if (collection.candidates.length === 0 && collection.rejectedImageCount === 0) {
    return value;
  }
  return redactCollectedProviderImagePayloads(value);
}

function redactCollectedProviderImagePayloads(value: unknown): unknown {
  const sanitized = sanitizeImagePayloads(value);
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
): MessageAttachment | null {
  const inlineData = parseInlineImageDataUri(candidate.data);
  const rawBase64 = inlineData?.data ?? candidate.data;
  const base64 = rawBase64.replace(/\s/g, "");
  if (
    base64.length === 0
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
  if (size === 0) {
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
    ? "its format is unsupported"
    : "their format is unsupported";
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
    seen: new WeakSet(),
  };
  collectImageCandidates(value, collection);

  const events: HarnessEventPayload[] = [];
  for (const [candidateIndex, candidate] of collection.candidates.entries()) {
    const attachment = decodeImageAttachment(
      candidate,
      sourceId,
      candidateIndex,
    );
    if (!attachment) {
      collection.rejectedImageCount += 1;
      continue;
    }
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
