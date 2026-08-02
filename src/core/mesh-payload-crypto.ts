/**
 * Recipient-bound encryption for semantic mesh checkpoint payloads.
 *
 * Node signing keys authenticate the protocol. A separate RSA key in the
 * node identity file wraps a per-checkpoint AES-GCM key so payloads are not
 * exposed to intermediate peers or network observers.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import type { MeshSyncCheckpointRecord } from "@/shared/mesh";
import { DomainError } from "./domain-error";
import { getLocalMeshEncryptionPrivateKey } from "../persistence/mesh-node-identity";

const ENCRYPTED_PAYLOAD_VERSION = 1;

interface EncryptedMeshPayload {
  __clankyMeshEncrypted: true;
  version: 1;
  wrappedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function isEncryptedMeshPayload(value: unknown): value is EncryptedMeshPayload {
  return typeof value === "object"
    && value !== null
    && (value as Record<string, unknown>)["__clankyMeshEncrypted"] === true
    && (value as Record<string, unknown>)["version"] === ENCRYPTED_PAYLOAD_VERSION
    && typeof (value as Record<string, unknown>)["wrappedKey"] === "string"
    && typeof (value as Record<string, unknown>)["iv"] === "string"
    && typeof (value as Record<string, unknown>)["authTag"] === "string"
    && typeof (value as Record<string, unknown>)["ciphertext"] === "string";
}

export function encryptMeshPayload(
  value: unknown,
  recipientEncryptionPublicKey: string,
): EncryptedMeshPayload {
  try {
    const contentKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const wrappedKey = publicEncrypt(
      {
        key: recipientEncryptionPublicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      contentKey,
    );
    return {
      __clankyMeshEncrypted: true,
      version: ENCRYPTED_PAYLOAD_VERSION,
      wrappedKey: wrappedKey.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } catch (error) {
    throw new DomainError(
      "mesh_payload_encryption_failed",
      "The mesh checkpoint payload could not be encrypted for its recipient.",
      { cause: error },
    );
  }
}

export async function decryptMeshPayload(value: unknown): Promise<unknown> {
  if (!isEncryptedMeshPayload(value)) {
    return value;
  }
  try {
    const privateKey = await getLocalMeshEncryptionPrivateKey();
    const contentKey = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(value.wrappedKey, "base64url"),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      contentKey,
      Buffer.from(value.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(value.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch (error) {
    throw new DomainError(
      "mesh_payload_decryption_failed",
      "The mesh checkpoint payload could not be decrypted by this node.",
      { cause: error },
    );
  }
}

export function encryptMeshCheckpoint(
  checkpoint: MeshSyncCheckpointRecord,
  recipientEncryptionPublicKey: string,
): MeshSyncCheckpointRecord {
  return {
    ...checkpoint,
    basePayload: checkpoint.basePayload === null
      ? null
      : encryptMeshPayload(checkpoint.basePayload, recipientEncryptionPublicKey),
    payload: checkpoint.payload === null
      ? null
      : encryptMeshPayload(checkpoint.payload, recipientEncryptionPublicKey),
  };
}

export async function decryptMeshCheckpoint(
  checkpoint: MeshSyncCheckpointRecord,
): Promise<MeshSyncCheckpointRecord> {
  return {
    ...checkpoint,
    basePayload: await decryptMeshPayload(checkpoint.basePayload),
    payload: await decryptMeshPayload(checkpoint.payload),
  };
}
