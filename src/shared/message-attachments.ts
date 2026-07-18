/**
 * Shared message attachment types and limits.
 *
 * Attachments are passed from the browser to ACP as inline data and may be
 * persisted with task messages so refreshed log views can still render them.
 * The API field remains `attachments` for both images and supported documents.
 */

export const MESSAGE_ATTACHMENT_LIMIT = 8;
export const MESSAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Explicit image MIME allowlist — excludes image/svg+xml to avoid script injection risks. */
export const MESSAGE_IMAGE_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const MESSAGE_DOCUMENT_ALLOWED_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
] as const;

export const MESSAGE_ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  ...MESSAGE_DOCUMENT_ALLOWED_MIME_TYPES,
] as const;

export const MESSAGE_DOCUMENT_ALLOWED_EXTENSIONS = [
  ".txt",
  ".md",
  ".pdf",
] as const;

export type MessageAttachmentKind = "image" | "text" | "pdf";

export type MessageImageMimeType = typeof MESSAGE_IMAGE_ALLOWED_MIME_TYPES[number];
export type MessageDocumentMimeType = typeof MESSAGE_DOCUMENT_ALLOWED_MIME_TYPES[number];

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  data: string;
  size: number;
}

/**
 * Compatibility name retained while callers migrate to the generic
 * `MessageAttachment` contract.
 */
export type MessageImageAttachment = MessageAttachment;

export interface ComposerAttachment extends MessageAttachment {
  /** Object URL used only for image previews; revoked when the attachment is removed. */
  previewUrl?: string;
}

/** Compatibility name retained for image-only callers. */
export interface ComposerImageAttachment extends MessageAttachment {
  previewUrl: string;
}

export const MESSAGE_ATTACHMENT_ACCEPT = [
  ...MESSAGE_ATTACHMENT_ALLOWED_MIME_TYPES,
  ...MESSAGE_DOCUMENT_ALLOWED_EXTENSIONS,
].join(",");

export const MESSAGE_IMAGE_ACCEPT = MESSAGE_IMAGE_ALLOWED_MIME_TYPES.join(",");

export const MESSAGE_IMAGE_ATTACHMENT_LIMIT = MESSAGE_ATTACHMENT_LIMIT;
export const MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES = MESSAGE_ATTACHMENT_MAX_BYTES;

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function getMessageAttachmentExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}

export function getMessageAttachmentKind(
  attachment: Pick<MessageAttachment, "filename" | "mimeType">,
): MessageAttachmentKind | null {
  const mimeType = normalizeMimeType(attachment.mimeType);
  if ((MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return "image";
  }
  if (mimeType === "application/pdf" || getMessageAttachmentExtension(attachment.filename) === ".pdf") {
    return "pdf";
  }
  if (
    (MESSAGE_DOCUMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)
    || getMessageAttachmentExtension(attachment.filename) === ".txt"
    || getMessageAttachmentExtension(attachment.filename) === ".md"
  ) {
    return "text";
  }
  return null;
}

export function isSupportedMessageAttachment(
  attachment: Pick<MessageAttachment, "filename" | "mimeType">,
): boolean {
  return getMessageAttachmentKind(attachment) !== null;
}

export function getCanonicalMessageAttachmentMimeType(
  attachment: Pick<MessageAttachment, "filename" | "mimeType">,
): string {
  const kind = getMessageAttachmentKind(attachment);
  if (kind === "pdf") {
    return "application/pdf";
  }
  if (kind === "text") {
    return getMessageAttachmentExtension(attachment.filename) === ".md" ? "text/markdown" : "text/plain";
  }
  return normalizeMimeType(attachment.mimeType);
}
