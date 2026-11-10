import { createPublicKey, verify } from "node:crypto";
import { SaxesParser } from "saxes";
import { z } from "zod";
import { sparkle } from "./sparkle";

export const updateMetadata = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["stable", "latest"]),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  buildNumber: z.string().regex(/^[1-9]\d{0,3}\.\d{1,2}\.\d{1,2}$/),
  archive: z.string().regex(/^Clanky-v[0-9A-Za-z.+-]+-macos-arm64-notarized\.zip$/),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  appcastSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export function sha256(bytes: string | ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function compareBuilds(first: string, second: string): number {
  const left = first.split(".").map(Number);
  const right = second.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!;
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function readAppcast(xml: string): {
  buildNumber?: string; channel?: string; url?: string; bytes?: number; signature?: string;
} {
  const parser = new SaxesParser();
  const result: ReturnType<typeof readAppcast> = {};
  let items = 0;
  let current = "";
  let text = "";
  parser.on("opentag", tag => {
    current = tag.name;
    text = "";
    if (current === "item") items++;
    if (current === "enclosure") {
      if (result.url) throw new Error("Mac appcast must contain only one full archive.");
      result.url = String(tag.attributes["url"] ?? "");
      result.bytes = Number(tag.attributes["length"]);
      result.signature = String(tag.attributes["sparkle:edSignature"] ?? "");
    }
  });
  parser.on("text", value => { text += value; });
  parser.on("cdata", value => { text += value; });
  parser.on("closetag", tag => {
    if (tag.name === "sparkle:version") result.buildNumber = text.trim();
    if (tag.name === "sparkle:channel") result.channel = text.trim();
    current = "";
    text = "";
  });
  parser.write(xml).close();
  if (items > 1 || (items === 1 && (!/^[1-9]\d{0,3}\.\d{1,2}\.\d{1,2}$/.test(result.buildNumber ?? "")
    || !result.url || !result.signature || !Number.isSafeInteger(result.bytes) || result.bytes! <= 0))) {
    throw new Error("Invalid Mac appcast build or archive metadata.");
  }
  return result;
}

export function verifyUpdateArchive(xml: string, archive: Uint8Array): void {
  const item = readAppcast(xml);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(sparkle.publicKey, "base64")]),
    format: "der", type: "spki",
  });
  if (archive.byteLength !== item.bytes || !item.signature
    || !verify(null, archive, publicKey, Buffer.from(item.signature, "base64"))) {
    throw new Error("Mac update archive has an invalid length or Ed25519 signature.");
  }
}
