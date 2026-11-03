import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function hmacSha256(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}
