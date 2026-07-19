import { createClientLogger } from "./client-logger";

const log = createClientLogger("vncBrowserCredentials");

const VNC_PASSWORD_STORAGE_PREFIX = "clanky.vncPassword.";
const VNC_PASSWORD_KEY_STORAGE_PREFIX = "clanky.vncPasswordKey.";
const VNC_PASSWORD_ALGORITHM = "AES-GCM-256";
const VNC_PASSWORD_VERSION = 1;

export interface VncCredentialStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface VncBrowserCredentialDependencies {
  storage?: VncCredentialStorageLike;
  crypto?: Pick<Crypto, "getRandomValues">;
  subtle?: SubtleCrypto;
  now?: () => Date;
}

export interface StoredVncPassword {
  encryptedPassword: EncryptedVncPassword;
  storedAt: string;
}

export interface StoredVncCredentials {
  encryptedCredentials: EncryptedVncPassword;
  storedAt: string;
}

export interface VncCredentials {
  username: string;
  password: string;
}

export interface StoredVncCredentialsResult {
  username?: string;
  password: string;
}

export interface EncryptedVncPassword {
  algorithm: typeof VNC_PASSWORD_ALGORITHM;
  version: typeof VNC_PASSWORD_VERSION;
  iv: string;
  ciphertext: string;
}

function resolveStorage(storage?: VncCredentialStorageLike): VncCredentialStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage;
}

function resolveSubtle(subtle?: SubtleCrypto): SubtleCrypto {
  const resolvedSubtle = subtle ?? globalThis.crypto?.subtle;
  if (!resolvedSubtle) {
    throw new Error("Web Crypto is not available in this environment");
  }
  return resolvedSubtle;
}

function resolveCrypto(crypto?: Pick<Crypto, "getRandomValues">): Pick<Crypto, "getRandomValues"> {
  const resolvedCrypto = crypto ?? globalThis.crypto;
  if (!resolvedCrypto) {
    throw new Error("Web Crypto is not available in this environment");
  }
  return resolvedCrypto;
}

function getPasswordStorageKey(serverId: string): string {
  return `${VNC_PASSWORD_STORAGE_PREFIX}${serverId}`;
}

function getEncryptionKeyStorageKey(serverId: string): string {
  return `${VNC_PASSWORD_KEY_STORAGE_PREFIX}${serverId}`;
}

function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isEncryptedVncPasswordShape(value: unknown): value is EncryptedVncPassword {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["algorithm"] === VNC_PASSWORD_ALGORITHM
    && record["version"] === VNC_PASSWORD_VERSION
    && typeof record["iv"] === "string"
    && typeof record["ciphertext"] === "string";
}

function isStoredVncPasswordShape(value: unknown): value is StoredVncPassword {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["storedAt"] === "string"
    && isEncryptedVncPasswordShape(record["encryptedPassword"]);
}

function isStoredVncCredentialsShape(value: unknown): value is StoredVncCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["storedAt"] === "string"
    && isEncryptedVncPasswordShape(record["encryptedCredentials"]);
}

function isStoredVncCredentialPayload(value: unknown): value is VncCredentials {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["username"] === "string"
    && typeof record["password"] === "string";
}

async function getEncryptionKey(
  serverId: string,
  dependencies: VncBrowserCredentialDependencies,
): Promise<CryptoKey> {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    throw new Error("Browser storage is not available in this environment");
  }

  let rawKey = storage.getItem(getEncryptionKeyStorageKey(serverId));
  if (!rawKey) {
    const keyBytes = new Uint8Array(32);
    resolveCrypto(dependencies.crypto).getRandomValues(keyBytes);
    rawKey = encodeArrayBufferToBase64(keyBytes.buffer);
    storage.setItem(getEncryptionKeyStorageKey(serverId), rawKey);
  }

  return await resolveSubtle(dependencies.subtle).importKey(
    "raw",
    decodeBase64ToArrayBuffer(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export function getStoredVncCredentialsRecord(
  serverId: string,
  dependencies: VncBrowserCredentialDependencies = {},
): StoredVncCredentials | StoredVncPassword | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(getPasswordStorageKey(serverId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredVncCredentialsShape(parsed) && !isStoredVncPasswordShape(parsed)) {
      storage.removeItem(getPasswordStorageKey(serverId));
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn("Removing invalid stored VNC password payload", {
      serverId,
      error: String(error),
    });
    storage.removeItem(getPasswordStorageKey(serverId));
    return null;
  }
}

export const getStoredVncPasswordRecord = getStoredVncCredentialsRecord;

export async function storeVncCredentials(
  serverId: string,
  credentials: VncCredentials,
  dependencies: VncBrowserCredentialDependencies = {},
): Promise<StoredVncCredentials> {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    throw new Error("Browser storage is not available in this environment");
  }

  const iv = new Uint8Array(12);
  resolveCrypto(dependencies.crypto).getRandomValues(iv);
  const ciphertext = await resolveSubtle(dependencies.subtle).encrypt(
    { name: "AES-GCM", iv },
    await getEncryptionKey(serverId, dependencies),
    new TextEncoder().encode(JSON.stringify(credentials)),
  );
  const record: StoredVncCredentials = {
    encryptedCredentials: {
      algorithm: VNC_PASSWORD_ALGORITHM,
      version: VNC_PASSWORD_VERSION,
      iv: encodeArrayBufferToBase64(iv.buffer),
      ciphertext: encodeArrayBufferToBase64(ciphertext),
    },
    storedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  storage.setItem(getPasswordStorageKey(serverId), JSON.stringify(record));
  return record;
}

export async function storeVncPassword(
  serverId: string,
  password: string,
  dependencies: VncBrowserCredentialDependencies = {},
): Promise<StoredVncCredentials> {
  return await storeVncCredentials(serverId, { username: "", password }, dependencies);
}

export async function getStoredVncCredentials(
  serverId: string,
  dependencies: VncBrowserCredentialDependencies = {},
): Promise<StoredVncCredentialsResult | null> {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }
  const record = getStoredVncCredentialsRecord(serverId, dependencies);
  if (!record) {
    return null;
  }

  const encryptedValue = "encryptedCredentials" in record
    ? record.encryptedCredentials
    : record.encryptedPassword;

  try {
    const decrypted = await resolveSubtle(dependencies.subtle).decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64ToArrayBuffer(encryptedValue.iv),
      },
      await getEncryptionKey(serverId, dependencies),
      decodeBase64ToArrayBuffer(encryptedValue.ciphertext),
    );
    const decryptedText = new TextDecoder().decode(decrypted);
    if ("encryptedPassword" in record) {
      return { password: decryptedText };
    }
    const parsed = JSON.parse(decryptedText) as unknown;
    if (!isStoredVncCredentialPayload(parsed)) {
      clearStoredVncPassword(serverId, dependencies);
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn("Removing undecryptable stored VNC password payload", {
      serverId,
      error: String(error),
    });
    clearStoredVncPassword(serverId, dependencies);
    return null;
  }
}

export async function getStoredVncPassword(
  serverId: string,
  dependencies: VncBrowserCredentialDependencies = {},
): Promise<string | null> {
  return (await getStoredVncCredentials(serverId, dependencies))?.password ?? null;
}

export function clearStoredVncPassword(
  serverId: string,
  dependencies: VncBrowserCredentialDependencies = {},
): void {
  const storage = resolveStorage(dependencies.storage);
  storage?.removeItem(getPasswordStorageKey(serverId));
  storage?.removeItem(getEncryptionKeyStorageKey(serverId));
}
