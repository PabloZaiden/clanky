/**
 * Browser clipboard helper with a legacy execCommand fallback.
 */

import {
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
} from "@/shared/message-attachments";

export interface ClipboardReadResult {
  /** Files copied to the clipboard that can be sent as message attachments. */
  attachmentFiles: File[];
  text: string | null;
}

function getClipboardReadError(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : "";
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return new Error(
      "Clipboard access was denied. Check the browser permission and try again.",
      { cause: error },
    );
  }

  if (error instanceof Error) {
    return new Error(`Unable to read the browser clipboard: ${error.message}`, { cause: error });
  }

  return new Error(`Unable to read the browser clipboard: ${String(error)}`, { cause: error });
}

function getClipboardFileExtension(mimeType: string): string {
  const normalizedMimeType = getClipboardMimeTypeWithoutParameters(mimeType);
  if (normalizedMimeType === "image/jpeg") {
    return "jpg";
  }
  if (normalizedMimeType === "application/pdf") {
    return "pdf";
  }
  const subtype = normalizedMimeType.startsWith("image/")
    ? normalizedMimeType.slice("image/".length)
    : normalizedMimeType.split("/", 2)[1];
  return subtype || "bin";
}

function getClipboardMimeTypeWithoutParameters(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function findClipboardType(
  types: readonly string[],
  predicate: (mimeType: string) => boolean,
): string | undefined {
  return types.find((type) => predicate(getClipboardMimeTypeWithoutParameters(type)));
}

function isSupportedClipboardAttachmentType(mimeType: string): boolean {
  const normalizedMimeType = getClipboardMimeTypeWithoutParameters(mimeType);
  return (MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(normalizedMimeType)
    || normalizedMimeType === "application/pdf";
}

async function readClipboardItems(clipboard: Clipboard): Promise<ClipboardReadResult> {
  let items: ClipboardItems;
  try {
    items = await clipboard.read();
  } catch (error) {
    throw getClipboardReadError(error);
  }

  const attachmentItems = items.flatMap((item) => {
    const attachmentType = findClipboardType(item.types, isSupportedClipboardAttachmentType);
    return attachmentType ? [{ item, attachmentType }] : [];
  });

  if (attachmentItems.length > 0) {
    const attachmentFiles: File[] = [];
    for (const [index, { item, attachmentType }] of attachmentItems.entries()) {
      let blob: Blob;
      try {
        blob = await item.getType(attachmentType);
      } catch (error) {
        throw getClipboardReadError(error);
      }

      const mimeType = blob.type || attachmentType;
      attachmentFiles.push(new File(
        [blob],
        `clipboard-attachment-${index + 1}.${getClipboardFileExtension(mimeType)}`,
        { type: mimeType },
      ));
    }
    return { attachmentFiles, text: null };
  }

  let textItem: ClipboardItem | undefined;
  let textType: string | undefined;
  for (const item of items) {
    const matchedType = findClipboardType(item.types, (type) => type === "text/plain");
    if (matchedType !== undefined) {
      textItem = item;
      textType = matchedType;
      break;
    }
  }
  if (textItem === undefined || textType === undefined) {
    return { attachmentFiles: [], text: null };
  }

  try {
    const textBlob = await textItem.getType(textType);
    return { attachmentFiles: [], text: await textBlob.text() };
  } catch (error) {
    throw getClipboardReadError(error);
  }
}

export async function readClipboardContent(): Promise<ClipboardReadResult> {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw new Error("Clipboard access requires a secure browser context.");
  }

  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard) {
    throw new Error("Browser clipboard access is unavailable.");
  }

  if (typeof clipboard.read === "function") {
    return await readClipboardItems(clipboard);
  }

  if (typeof clipboard.readText === "function") {
    try {
      return { attachmentFiles: [], text: await clipboard.readText() };
    } catch (error) {
      throw getClipboardReadError(error);
    }
  }

  throw new Error("Browser clipboard access is unavailable.");
}

export async function writeTextToClipboard(text: string): Promise<void> {
  let clipboardApiError: unknown;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardApiError = error;
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    if (clipboardApiError instanceof Error) {
      throw clipboardApiError;
    }
    if (clipboardApiError !== undefined) {
      throw new Error(String(clipboardApiError));
    }
    throw new Error("Browser clipboard access is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  let didCopy = false;
  try {
    textarea.focus();
    textarea.select();
    didCopy = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!didCopy) {
    if (clipboardApiError instanceof Error) {
      throw clipboardApiError;
    }
    if (clipboardApiError !== undefined) {
      throw new Error(String(clipboardApiError));
    }
    throw new Error("Browser clipboard access is unavailable.");
  }
}
