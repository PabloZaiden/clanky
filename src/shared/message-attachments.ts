/**
 * Shared message attachment types and limits.
 *
 * Images are sent inline; other files are materialized on the execution host.
 * Original bytes are persisted with messages using the same API contract.
 */

export const MESSAGE_ATTACHMENT_LIMIT = 20;
export const MESSAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_TURN_BYTES = 60 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_TURN_MIB =
  MESSAGE_ATTACHMENT_MAX_TURN_BYTES / (1024 * 1024);
export const MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES =
  Math.ceil(MESSAGE_ATTACHMENT_MAX_TURN_BYTES * 4 / 3) + 2 * 1024 * 1024;

/** Explicit image MIME allowlist — excludes image/svg+xml to avoid script injection risks. */
export const MESSAGE_IMAGE_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type MessageAttachmentKind = "image" | "file";

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  data: string;
  size: number;
}

export interface AttachmentContext {
  kind: "chat" | "task";
  id: string;
}

export interface AttachmentFileReference {
  attachmentIndex: number;
  path: string;
}

export interface PreparedAttachmentFiles {
  files: AttachmentFileReference[];
  directory?: string;
}

export function getBase64DecodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function isValidAttachmentBase64(data: string): boolean {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return false;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (data.endsWith("==")) {
    return (alphabet.indexOf(data.at(-3)!) & 15) === 0;
  }
  if (data.endsWith("=")) {
    return (alphabet.indexOf(data.at(-2)!) & 3) === 0;
  }
  return true;
}

export function getMessageAttachmentByteLength(
  attachments: readonly Pick<MessageAttachment, "data">[],
): number {
  return attachments.reduce(
    (total, attachment) => total + getBase64DecodedByteLength(attachment.data),
    0,
  );
}

export interface ComposerAttachment extends MessageAttachment {
  /** Object URL used only for image previews; revoked when the attachment is removed. */
  previewUrl?: string;
}

export const MESSAGE_IMAGE_ACCEPT = MESSAGE_IMAGE_ALLOWED_MIME_TYPES.join(",");

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function getMessageAttachmentExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}

export function getMessageAttachmentKind(
  attachment: Pick<MessageAttachment, "filename" | "mimeType">,
): MessageAttachmentKind {
  const mimeType = normalizeMimeType(attachment.mimeType);
  if ((MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return "image";
  }
  return "file";
}

export function getCanonicalMessageAttachmentMimeType(
  attachment: Pick<MessageAttachment, "filename" | "mimeType">,
): string {
  return normalizeMimeType(attachment.mimeType) || "application/octet-stream";
}
