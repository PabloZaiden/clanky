import { createLogger } from "./logger";
import { appFetch } from "./public-path";
import type {
  SshCredentialExchangeResponse,
  SshServerEncryptedCredential,
  SshServerPublicKey,
} from "../types";

const log = createLogger("sshBrowserCredentials");
const SSH_CREDENTIAL_STORAGE_PREFIX = "clanky.sshServerCredential.";

interface CachedSshCredentialToken {
  credentialToken: string;
  expiresAt: number;
  storedAt: string;
}

const exchangedCredentialTokenCache = new Map<string, CachedSshCredentialToken>();

export interface StoredSshServerCredential {
  encryptedCredential: SshServerEncryptedCredential;
  storedAt: string;
}

export interface BrowserCredentialStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SshBrowserCredentialDependencies {
  fetchFn?: FetchLike;
  storage?: BrowserCredentialStorageLike;
  subtle?: SubtleCrypto;
  now?: () => Date;
}

function resolveStorage(storage?: BrowserCredentialStorageLike): BrowserCredentialStorageLike | null {
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

function resolveFetch(fetchFn?: FetchLike): FetchLike {
  return fetchFn ?? ((input, init) => appFetch(String(input), init));
}

function getStorageKey(serverId: string): string {
  return `${SSH_CREDENTIAL_STORAGE_PREFIX}${serverId}`;
}

function getNow(dependencies: SshBrowserCredentialDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

function clearCachedCredentialToken(serverId: string): void {
  exchangedCredentialTokenCache.delete(serverId);
}

export function invalidateStoredSshCredentialToken(serverId: string): void {
  clearCachedCredentialToken(serverId);
}

function getCachedCredentialToken(
  serverId: string,
  storedCredential: StoredSshServerCredential,
  dependencies: SshBrowserCredentialDependencies,
): string | null {
  const cachedToken = exchangedCredentialTokenCache.get(serverId);
  if (!cachedToken) {
    return null;
  }

  if (cachedToken.storedAt !== storedCredential.storedAt || cachedToken.expiresAt <= getNow(dependencies).getTime()) {
    exchangedCredentialTokenCache.delete(serverId);
    return null;
  }

  return cachedToken.credentialToken;
}

function cacheCredentialToken(
  serverId: string,
  storedCredential: StoredSshServerCredential,
  exchange: SshCredentialExchangeResponse,
): void {
  const expiresAt = Date.parse(exchange.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return;
  }

  exchangedCredentialTokenCache.set(serverId, {
    credentialToken: exchange.credentialToken,
    expiresAt,
    storedAt: storedCredential.storedAt,
  });
}

function decodePemToArrayBuffer(publicKeyPem: string): ArrayBuffer {
  const normalized = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function isStoredCredentialShape(value: unknown): value is StoredSshServerCredential {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const encryptedCredential = record["encryptedCredential"];
  if (!encryptedCredential || typeof encryptedCredential !== "object") {
    return false;
  }
  const credential = encryptedCredential as Record<string, unknown>;
  return typeof credential["algorithm"] === "string"
    && typeof credential["fingerprint"] === "string"
    && typeof credential["version"] === "number"
    && typeof credential["ciphertext"] === "string"
    && typeof record["storedAt"] === "string";
}

export function getStoredSshServerCredential(
  serverId: string,
  dependencies: SshBrowserCredentialDependencies = {},
): StoredSshServerCredential | null {
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(getStorageKey(serverId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredCredentialShape(parsed)) {
      storage.removeItem(getStorageKey(serverId));
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn("Removing invalid stored SSH credential payload", {
      serverId,
      error: String(error),
    });
    storage.removeItem(getStorageKey(serverId));
    return null;
  }
}

export function clearStoredSshServerCredential(
  serverId: string,
  dependencies: SshBrowserCredentialDependencies = {},
): void {
  clearCachedCredentialToken(serverId);
  resolveStorage(dependencies.storage)?.removeItem(getStorageKey(serverId));
}

export async function fetchSshServerPublicKey(
  serverId: string,
  dependencies: SshBrowserCredentialDependencies = {},
): Promise<SshServerPublicKey> {
  const response = await resolveFetch(dependencies.fetchFn)(`/api/ssh-servers/${serverId}/public-key`);
  if (!response.ok) {
    throw new Error(`Failed to fetch SSH server public key for ${serverId}`);
  }
  return await response.json() as SshServerPublicKey;
}

export async function encryptSshServerPassword(
  password: string,
  publicKey: SshServerPublicKey,
  dependencies: SshBrowserCredentialDependencies = {},
): Promise<SshServerEncryptedCredential> {
  const subtle = resolveSubtle(dependencies.subtle);
  const importedKey = await subtle.importKey(
    "spki",
    decodePemToArrayBuffer(publicKey.publicKey),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
  const encodedPassword = new TextEncoder().encode(password);
  const ciphertext = await subtle.encrypt({ name: "RSA-OAEP" }, importedKey, encodedPassword);
  return {
    algorithm: publicKey.algorithm,
    fingerprint: publicKey.fingerprint,
    version: publicKey.version,
    ciphertext: encodeArrayBufferToBase64(ciphertext),
  };
}

export function isStoredCredentialCompatible(
  record: StoredSshServerCredential,
  publicKey: SshServerPublicKey,
): boolean {
  return record.encryptedCredential.algorithm === publicKey.algorithm
    && record.encryptedCredential.fingerprint === publicKey.fingerprint
    && record.encryptedCredential.version === publicKey.version;
}

export function saveStoredSshServerCredential(
  serverId: string,
  encryptedCredential: SshServerEncryptedCredential,
  dependencies: SshBrowserCredentialDependencies = {},
): StoredSshServerCredential {
  clearCachedCredentialToken(serverId);
  const storage = resolveStorage(dependencies.storage);
  if (!storage) {
    throw new Error("Browser storage is not available in this environment");
  }
  const record: StoredSshServerCredential = {
    encryptedCredential,
    storedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  storage.setItem(getStorageKey(serverId), JSON.stringify(record));
  return record;
}

export async function storeSshServerPassword(
  serverId: string,
  password: string,
  dependencies: SshBrowserCredentialDependencies = {},
): Promise<StoredSshServerCredential> {
  const publicKey = await fetchSshServerPublicKey(serverId, dependencies);
  const encryptedCredential = await encryptSshServerPassword(password, publicKey, dependencies);
  return saveStoredSshServerCredential(serverId, encryptedCredential, dependencies);
}

export async function exchangeSshServerCredential(
  serverId: string,
  encryptedCredential: SshServerEncryptedCredential,
  dependencies: SshBrowserCredentialDependencies = {},
): Promise<SshCredentialExchangeResponse> {
  const response = await resolveFetch(dependencies.fetchFn)(`/api/ssh-servers/${serverId}/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptedCredential }),
  });
  if (!response.ok) {
    const errorData = await response.json() as Record<string, unknown>;
    const message = (errorData["message"] as string | undefined) ?? "Failed to exchange SSH credential";
    const error = new Error(message);
    (error as Error & { code?: string }).code = (
      errorData["code"] as string | undefined
    ) ?? (
      errorData["error"] as string | undefined
    );
    throw error;
  }
  return await response.json() as SshCredentialExchangeResponse;
}

export async function getStoredSshCredentialToken(
  serverId: string,
  dependencies: SshBrowserCredentialDependencies = {},
): Promise<string | null> {
  const storedCredential = getStoredSshServerCredential(serverId, dependencies);
  if (!storedCredential) {
    clearCachedCredentialToken(serverId);
    return null;
  }

  const cachedCredentialToken = getCachedCredentialToken(serverId, storedCredential, dependencies);
  if (cachedCredentialToken) {
    return cachedCredentialToken;
  }

  const publicKey = await fetchSshServerPublicKey(serverId, dependencies);
  if (!isStoredCredentialCompatible(storedCredential, publicKey)) {
    clearStoredSshServerCredential(serverId, dependencies);
    return null;
  }

  try {
    const exchange = await exchangeSshServerCredential(
      serverId,
      storedCredential.encryptedCredential,
      dependencies,
    );
    cacheCredentialToken(serverId, storedCredential, exchange);
    return exchange.credentialToken;
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "invalid_encrypted_credential") {
      clearStoredSshServerCredential(serverId, dependencies);
      return null;
    }
    throw error;
  }
}
