/**
 * Synthetic originals and independently calculated file-inspection results.
 */
export function createFileAttachment(filename: string, contents: string | Uint8Array, mimeType = "application/octet-stream") {
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  return {
    id: crypto.randomUUID(), filename, mimeType,
    data: bytes.toString("base64"), size: bytes.byteLength,
  };
}

export function expectedFileInspection(attachment: ReturnType<typeof createFileAttachment>) {
  return {
    name: attachment.filename, size: attachment.size,
    sha256: new Bun.CryptoHasher("sha256").update(Buffer.from(attachment.data, "base64")).digest("hex"),
  };
}
