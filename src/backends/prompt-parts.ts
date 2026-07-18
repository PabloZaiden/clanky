/**
 * Converts persisted message attachments into protocol prompt parts.
 */

import {
  getCanonicalMessageAttachmentMimeType,
  getMessageAttachmentKind,
  type MessageAttachment,
} from "@/shared/message-attachments";
import type { PromptInput, PromptPart } from "./types";

function buildAttachmentUri(attachment: MessageAttachment): string {
  return `attachment://${encodeURIComponent(attachment.id)}/${encodeURIComponent(attachment.filename)}`;
}

function decodeTextAttachment(data: string): string {
  return Buffer.from(data, "base64").toString("utf8");
}

function buildAttachmentPromptPart(attachment: MessageAttachment): PromptPart {
  const kind = getMessageAttachmentKind(attachment);
  const mimeType = getCanonicalMessageAttachmentMimeType(attachment);
  const uri = buildAttachmentUri(attachment);

  if (kind === "image") {
    return {
      type: "image",
      mimeType,
      data: attachment.data,
      filename: attachment.filename,
    };
  }

  if (kind === "pdf") {
    return {
      type: "resource",
      resource: {
        uri,
        mimeType,
        blob: attachment.data,
      },
    };
  }

  if (kind === "text") {
    return {
      type: "resource",
      resource: {
        uri,
        mimeType,
        text: decodeTextAttachment(attachment.data),
      },
    };
  }

  throw new Error(`Unsupported attachment type: ${attachment.filename}`);
}

export function buildPromptParts(
  text: string,
  attachments: readonly MessageAttachment[],
): PromptInput["parts"] {
  const parts = attachments.map((attachment) => buildAttachmentPromptPart(attachment));
  return text.length > 0 ? [{ type: "text", text }, ...parts] : parts;
}
