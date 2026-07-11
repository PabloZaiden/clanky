/**
 * Browser clipboard helper with a legacy execCommand fallback.
 */

export interface ClipboardReadResult {
  imageFiles: File[];
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

function getClipboardImageExtension(mimeType: string): string {
  const subtype = mimeType.slice("image/".length).split(/[;+]/, 1)[0]?.toLowerCase();
  if (subtype === "jpeg") {
    return "jpg";
  }
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

async function readClipboardItems(clipboard: Clipboard): Promise<ClipboardReadResult> {
  let items: ClipboardItems;
  try {
    items = await clipboard.read();
  } catch (error) {
    throw getClipboardReadError(error);
  }

  const imageItems = items.flatMap((item) => {
    const imageType = findClipboardType(item.types, (type) => type.startsWith("image/"));
    return imageType ? [{ item, imageType }] : [];
  });

  if (imageItems.length > 0) {
    const imageFiles: File[] = [];
    for (const [index, { item, imageType }] of imageItems.entries()) {
      let blob: Blob;
      try {
        blob = await item.getType(imageType);
      } catch (error) {
        throw getClipboardReadError(error);
      }

      const mimeType = blob.type || imageType;
      imageFiles.push(new File(
        [blob],
        `clipboard-image-${index + 1}.${getClipboardImageExtension(mimeType)}`,
        { type: mimeType },
      ));
    }
    return { imageFiles, text: null };
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
    return { imageFiles: [], text: null };
  }

  try {
    const textBlob = await textItem.getType(textType);
    return { imageFiles: [], text: await textBlob.text() };
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
      return { imageFiles: [], text: await clipboard.readText() };
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
