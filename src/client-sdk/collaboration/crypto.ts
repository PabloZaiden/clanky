/**
 * Wire-compatible Web Crypto primitives for invited collaboration clients.
 */

import { decodeBase64Url, encodeBase64Url, utf8Bytes } from "@/shared/encoding";

function decodePublicKeyPem(value: string): Uint8Array<ArrayBuffer> {
  const match = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PUBLIC KEY-----\r?\n?$/.exec(value);
  if (!match) throw new TypeError("An SPKI Ed25519 public key is required.");
  const encoded = match[1]!.replace(/[\r\n]/g, "");
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== encoded) throw new TypeError("Invalid public key encoding.");
  return bytes;
}

async function importPublicKey(value: string): Promise<{ key: CryptoKey; der: Uint8Array<ArrayBuffer> }> {
  const der = decodePublicKeyPem(value);
  const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  return { key, der };
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getClientKeyFingerprint(publicKey: string): Promise<string> {
  const { der } = await importPublicKey(publicKey);
  return `sha256:${await sha256Hex(der)}`;
}

export async function verifyClientSignature(payload: string, signature: string, publicKey: string): Promise<boolean> {
  const { key } = await importPublicKey(publicKey);
  return await crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64Url(signature), utf8Bytes(payload));
}

export async function generateClientSigningKey(): Promise<{
  publicKey: string;
  fingerprint: string;
  privateKey: CryptoKey;
}> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const encoded = btoa(String.fromCharCode(...der));
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  return { publicKey, fingerprint: `sha256:${await sha256Hex(der)}`, privateKey: keys.privateKey };
}

export async function signClientPayload(privateKey: CryptoKey, payload: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, utf8Bytes(payload))));
}
