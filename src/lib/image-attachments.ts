import type { ComposerImageAttachment, MessageImageAttachment } from "../types/message-attachments";
import {
  MESSAGE_IMAGE_ACCEPT,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
} from "../types/message-attachments";

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

export function getClipboardImageFiles(
  items: ArrayLike<DataTransferItem> | null | undefined,
): File[] {
  if (!items) {
    return [];
  }

  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (file !== null) {
      files.push(file);
    }
  }

  return files;
}

export async function createComposerImageAttachments(
  files: File[],
  existingCount = 0,
): Promise<ComposerImageAttachment[]> {
  if (existingCount + files.length > MESSAGE_IMAGE_ATTACHMENT_LIMIT) {
    throw new Error(`You can attach up to ${MESSAGE_IMAGE_ATTACHMENT_LIMIT} images at a time.`);
  }

  return Promise.all(files.map(async (file) => {
    if (!(MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      throw new Error(`${file.name} is not a supported image type. Accepted: ${MESSAGE_IMAGE_ALLOWED_MIME_TYPES.join(", ")}.`);
    }

    if (file.size > MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error(`${file.name} is larger than ${Math.floor(MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB.`);
    }

    const dataUrl = await readFileAsDataUrl(file);
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex === -1) {
      throw new Error(`Failed to parse ${file.name}.`);
    }

    return {
      id: crypto.randomUUID(),
      filename: file.name,
      mimeType: file.type,
      data: dataUrl.slice(commaIndex + 1),
      size: file.size,
      previewUrl: URL.createObjectURL(file),
    };
  }));
}

export function revokeComposerImageAttachments(attachments: ComposerImageAttachment[]): void {
  attachments.forEach((attachment) => {
    URL.revokeObjectURL(attachment.previewUrl);
  });
}

export function toMessageImageAttachments(
  attachments: ComposerImageAttachment[],
): MessageImageAttachment[] {
  return attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
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
  MESSAGE_IMAGE_ACCEPT,
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
};
