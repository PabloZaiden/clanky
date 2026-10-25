/**
 * Canonical UTF-8 and unpadded base64url encoding for portable contracts.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new TypeError("Invalid base64url encoding.");
  }
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new TypeError("Noncanonical base64url encoding.");
  return bytes;
}

export function encodeJsonBase64Url(value: unknown): string {
  return encodeBase64Url(utf8Bytes(JSON.stringify(value)));
}

export function decodeUtf8Base64Url(value: string): string {
  return decoder.decode(decodeBase64Url(value));
}
