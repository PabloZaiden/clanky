const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const IMAGE_RECEIPT = "E2E image received: image/png; PNG signature OK";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePng(mimeType: unknown, data: unknown): string {
  if (mimeType !== "image/png" || typeof data !== "string") {
    throw new Error("The E2E provider received an invalid image attachment.");
  }
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length === 0
    || bytes.toString("base64") !== data
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("The E2E provider received invalid PNG data.");
  }
  return IMAGE_RECEIPT;
}

export function readCodexImageReceipts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "image") return [];
    const url = part["url"];
    const prefix = "data:image/png;base64,";
    if (typeof url !== "string" || !url.startsWith(prefix)) {
      throw new Error("Codex image input must use an inline PNG data URL.");
    }
    return [validatePng("image/png", url.slice(prefix.length))];
  });
}

export function readCopilotImageReceipts(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (
      !isRecord(attachment)
      || typeof attachment["mimeType"] !== "string"
      || !attachment["mimeType"].startsWith("image/")
    ) {
      return [];
    }
    if (attachment["type"] !== "blob") {
      throw new Error("Copilot image input must use an inline blob attachment.");
    }
    return [validatePng(attachment["mimeType"], attachment["data"])];
  });
}
