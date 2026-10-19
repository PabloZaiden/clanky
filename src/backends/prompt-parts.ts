/**
 * Builds inline image parts and references to already materialized files.
 */

import {
  getCanonicalMessageAttachmentMimeType,
  getMessageAttachmentKind,
  type PreparedAttachmentFiles,
  type MessageAttachment,
} from "@/shared/message-attachments";
import type { PromptInput } from "./types";

export function buildPromptParts(
  text: string,
  attachments: readonly MessageAttachment[],
  prepared: PreparedAttachmentFiles,
): PromptInput["parts"] {
  const paths = new Map(prepared.files.map((file) => [file.attachmentIndex, file.path]));
  const parts: PromptInput["parts"] = text.length > 0 ? [{ type: "text", text }] : [];
  if (prepared.directory) {
    parts.push({
      type: "text",
      text: `Files attached to this conversation remain available to your tools in this directory:\n${JSON.stringify({ directory: prepared.directory })}`,
    });
  }
  for (const [index, attachment] of attachments.entries()) {
    if (getMessageAttachmentKind(attachment) === "image") {
      parts.push({
        type: "image",
        mimeType: getCanonicalMessageAttachmentMimeType(attachment),
        data: attachment.data,
        filename: attachment.filename,
      });
    } else {
      const path = paths.get(index);
      if (!path) throw new Error("File attachments must be materialized before building a prompt.");
      parts.push({
        type: "text",
        text: `Attached file (available to your tools on the execution host):\n${JSON.stringify({ name: attachment.filename, path })}`,
      });
    }
  }
  return parts;
}
