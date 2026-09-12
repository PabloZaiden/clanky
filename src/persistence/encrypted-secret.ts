/**
 * Installation-local authenticated encryption for persisted provider secrets.
 */

import { chmod } from "fs/promises";
import { join } from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { getDataDir } from "./database";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_BYTES = 32;
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTED_SECRET_VERSION = "v1";
const ENCRYPTION_KEY_FILENAME = "workspace-execution-target.key";

let cachedKeyPath: string | null = null;
let cachedEncryptionKey: Buffer | null = null;

export function resetPersistedSecretKeyCache(): void {
  cachedKeyPath = null;
  cachedEncryptionKey = null;
}

function getEncryptionKeyPath(): string {
  return join(getDataDir(), ENCRYPTION_KEY_FILENAME);
}

async function getEncryptionKey(): Promise<Buffer> {
  const keyPath = getEncryptionKeyPath();
  if (cachedKeyPath === keyPath && cachedEncryptionKey) {
    if (await Bun.file(keyPath).exists()) {
      return cachedEncryptionKey;
    }
    cachedKeyPath = null;
    cachedEncryptionKey = null;
  }

  const file = Bun.file(keyPath);
  if (await file.exists()) {
    const raw = (await file.text()).trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== ENCRYPTION_KEY_BYTES) {
      throw new Error("Persisted secret encryption key is invalid");
    }
    cachedKeyPath = keyPath;
    cachedEncryptionKey = key;
    return key;
  }

  const key = randomBytes(ENCRYPTION_KEY_BYTES);
  await Bun.write(keyPath, key.toString("base64"));
  await chmod(keyPath, 0o600);
  cachedKeyPath = keyPath;
  cachedEncryptionKey = key;
  return key;
}

export async function encryptPersistedSecret(secret: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTED_SECRET_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export async function decryptPersistedSecret(value: string): Promise<string> {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (
    version !== ENCRYPTED_SECRET_VERSION
    || !ivValue
    || !tagValue
    || !ciphertextValue
  ) {
    throw new Error("Persisted secret has an invalid format");
  }

  try {
    const key = await getEncryptionKey();
    const decipher = createDecipheriv(
      ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(ivValue, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt persisted secret", { cause: error });
  }
}
