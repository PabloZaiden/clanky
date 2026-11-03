import { z } from "zod";
import { readStorage, removeStorage, writeStorage } from "./storage";

const credentialsSchema = z.object({
  baseUrl: z.string().url(),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
});

export type WebAppClientCredentials = z.infer<typeof credentialsSchema>;

function validateCredentials(value: unknown, baseUrl: string): WebAppClientCredentials {
  const credentials = credentialsSchema.parse(value);
  if (credentials.baseUrl !== baseUrl) throw new Error("Saved credentials belong to a different server.");
  return credentials;
}

/** Native wrappers may keep refresh credentials in their platform key store. */
export interface WebAppClientCredentialStore {
  read(baseUrl: string): Promise<WebAppClientCredentials | undefined>;
  write(credentials: WebAppClientCredentials): Promise<void>;
  remove(baseUrl: string): Promise<void>;
}

export async function readClientCredentials(store: WebAppClientCredentialStore, baseUrl: string): Promise<WebAppClientCredentials | undefined> {
  const credentials = await store.read(baseUrl);
  return credentials === undefined ? undefined : validateCredentials(credentials, baseUrl);
}

export function clientStorageKey(name: string): string {
  const directory = new URL(".", document.baseURI).pathname;
  return `webapp.client:${encodeURIComponent(directory)}:${name}`;
}

export async function withClientCredentialLock<T>(baseUrl: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!navigator.locks) {
    throw new Error("Persistent sign-in requires a secure browser context with Web Locks support.");
  }
  return await navigator.locks.request(clientStorageKey(`credentials-lock:${baseUrl}`), { signal }, operation);
}

export function credentialsKey(baseUrl: string): string {
  return clientStorageKey(`credentials:${encodeURIComponent(baseUrl)}`);
}

export const browserClientCredentialStore: WebAppClientCredentialStore = {
  async read(baseUrl) {
    const result = readStorage(credentialsKey(baseUrl));
    if (!result.ok) throw result.error;
    if (result.value === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(result.value);
    } catch (cause) {
      throw new Error("Saved server credentials are invalid. Sign out and connect again.", { cause });
    }
    return validateCredentials(value, baseUrl);
  },
  async write(credentials) {
    const result = writeStorage(credentialsKey(credentials.baseUrl), JSON.stringify(credentialsSchema.parse(credentials)));
    if (!result.ok) throw result.error;
  },
  async remove(baseUrl) {
    const result = removeStorage(credentialsKey(baseUrl));
    if (!result.ok) throw result.error;
  },
};
