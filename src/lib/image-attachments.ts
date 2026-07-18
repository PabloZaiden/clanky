import type { ComposerAttachment, ComposerImageAttachment, MessageAttachment } from "@/shared/message-attachments";
import {
  getCanonicalMessageAttachmentMimeType,
  getMessageAttachmentKind,
  MESSAGE_ATTACHMENT_ACCEPT,
  MESSAGE_ATTACHMENT_ALLOWED_MIME_TYPES,
  MESSAGE_ATTACHMENT_LIMIT,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  MESSAGE_IMAGE_ACCEPT,
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
} from "@/shared/message-attachments";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error(`Failed to read ${file.name}`));
    };
    reader.onerror = () => {
      reject(new Error(`Failed to read ${file.name}`));
    };
    reader.readAsDataURL(file);
  });
}

export function getClipboardAttachmentFiles(
  items: ArrayLike<DataTransferItem> | null | undefined,
): File[] {
  if (!items) {
    return [];
  }

  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (
      file !== null
      && getMessageAttachmentKind({ filename: file.name, mimeType: file.type }) !== null
    ) {
      files.push(file);
    }
  }

  return files;
}

/** Compatibility name retained for existing paste handlers. */
export const getClipboardImageFiles = getClipboardAttachmentFiles;

export async function createComposerAttachments(
  files: File[],
  existingCount = 0,
): Promise<ComposerAttachment[]> {
  if (existingCount + files.length > MESSAGE_ATTACHMENT_LIMIT) {
    throw new Error(`You can attach up to ${MESSAGE_ATTACHMENT_LIMIT} files at a time.`);
  }

  const nextAttachments: ComposerAttachment[] = [];
  try {
    for (const file of files) {
      const metadata = { filename: file.name, mimeType: file.type };
      const kind = getMessageAttachmentKind(metadata);
      if (kind === null) {
        throw new Error(
          `${file.name} is not a supported attachment type. Accepted: ${MESSAGE_ATTACHMENT_ALLOWED_MIME_TYPES.join(", ")}, .txt, .md, .pdf.`,
        );
      }

      if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
        throw new Error(`${file.name} is larger than ${Math.floor(MESSAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`);
      }

      const dataUrl = await readFileAsDataUrl(file);
      const commaIndex = dataUrl.indexOf(",");
      if (commaIndex === -1) {
        throw new Error(`Failed to parse ${file.name}.`);
      }

      const attachment: ComposerAttachment = {
        id: crypto.randomUUID(),
        filename: file.name,
        mimeType: getCanonicalMessageAttachmentMimeType(metadata),
        data: dataUrl.slice(commaIndex + 1),
        size: file.size,
        ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
      };
      nextAttachments.push(attachment);
    }

    return nextAttachments;
  } catch (error) {
    revokeComposerAttachments(nextAttachments);
    throw error;
  }
}

export function revokeComposerAttachments(attachments: ComposerAttachment[]): void {
  attachments.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
}

export function toMessageAttachments(
  attachments: ComposerAttachment[],
): MessageAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
}

/** Compatibility name retained while existing callers migrate to generic attachments. */
export function createComposerImageAttachments(
  files: File[],
  existingCount = 0,
): Promise<ComposerAttachment[]> {
  return createComposerAttachments(files, existingCount);
}

/** Compatibility name retained while existing callers migrate to generic attachments. */
export function revokeComposerImageAttachments(attachments: ComposerImageAttachment[]): void {
  revokeComposerAttachments(attachments);
}

/** Compatibility name retained while existing callers migrate to generic attachments. */
export function toMessageImageAttachments(
  attachments: ComposerImageAttachment[],
): MessageAttachment[] {
  return toMessageAttachments(attachments);
}

/**
 * Strip the transient `attachments` field from a request before persisting.
 * Used by draft save and task edit flows to avoid storing image data.
 */
export function stripTransientAttachments<T extends { attachments?: unknown }>(request: T): Omit<T, "attachments"> {
  const { attachments: _attachments, ...persistedRequest } = request;
  return persistedRequest;
}

export {
  MESSAGE_ATTACHMENT_ACCEPT,
  MESSAGE_ATTACHMENT_LIMIT,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_IMAGE_ACCEPT,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
};
