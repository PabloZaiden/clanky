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

interface NativeCredentialLockBridge {
  postMessage(message: {
    type: "acquire" | "release" | "cancel";
    id: string;
    key: string;
    value?: string | null;
  }): Promise<unknown>;
}

declare global {
  interface Window {
    clankyClientCredentialLock?: NativeCredentialLockBridge;
  }
}

const nativeLockResponseSchema = z.object({ value: z.string().nullable().optional() }).strict();
const nativeLockAcknowledgmentSchema = z.literal(true);

function validateCredentials(value: unknown, baseUrl: string): WebAppClientCredentials {
  const credentials = credentialsSchema.parse(value);
  if (credentials.baseUrl !== baseUrl) throw new Error("Saved credentials belong to a different server.");
  return credentials;
}

function parseSavedCredentials(value: string, baseUrl: string): WebAppClientCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("Saved server credentials are invalid. Sign out and connect again.", { cause });
  }
  return validateCredentials(parsed, baseUrl);
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

async function withNativeCredentialLock<T>(
  bridge: NativeCredentialLockBridge,
  baseUrl: string,
  operation: () => Promise<T>,
  store: WebAppClientCredentialStore,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const key = clientStorageKey(`credentials-lock:${baseUrl}`);
  const request = bridge.postMessage({ type: "acquire", id, key });
  let acquired = false;
  let completed = false;
  let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  const cancel = () => {
    cancellation ??= bridge.postMessage({ type: "cancel", id, key })
      .then(response => nativeLockAcknowledgmentSchema.parse(response))
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    let response: unknown;
    try {
      response = await request;
      acquired = true;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    const { value } = nativeLockResponseSchema.parse(response);
    if (value === null) await store.remove(baseUrl);
    else if (value !== undefined) await store.write(parseSavedCredentials(value, baseUrl));
    signal?.throwIfAborted();
    const result = await operation();
    completed = true;
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      if (acquired) {
        let value: string | null | undefined;
        try {
          if (completed) {
            const saved = await readClientCredentials(store, baseUrl);
            value = saved ? JSON.stringify(saved) : null;
          }
        } finally {
          nativeLockAcknowledgmentSchema.parse(await bridge.postMessage({
            type: "release", id, key, ...(value !== undefined ? { value } : {}),
          }));
        }
      }
    } finally {
      const canceled = await cancellation;
      if (canceled?.ok === false) throw canceled.error;
    }
  }
}

export async function withClientCredentialLock<T>(
  baseUrl: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  store: WebAppClientCredentialStore = browserClientCredentialStore,
): Promise<T> {
  const native = window.clankyClientCredentialLock;
  if (native && store === browserClientCredentialStore) {
    return await withNativeCredentialLock(native, baseUrl, operation, store, signal);
  }
  if (!navigator.locks) {
    throw new Error("Persistent sign-in requires a secure browser context with Web Locks support.");
  }
  let pending: Promise<T> | undefined;
  try {
    return await navigator.locks.request(clientStorageKey(`credentials-lock:${baseUrl}`), { signal }, () => {
      pending = operation();
      return pending;
    });
  } finally {
    // WebKit can release a suspended page's lock before its operation settles.
    await pending;
  }
}

export function credentialsKey(baseUrl: string): string {
  return clientStorageKey(`credentials:${encodeURIComponent(baseUrl)}`);
}

export const browserClientCredentialStore: WebAppClientCredentialStore = {
  async read(baseUrl) {
    const result = readStorage(credentialsKey(baseUrl));
    if (!result.ok) throw result.error;
    if (result.value === null) return undefined;
    return parseSavedCredentials(result.value, baseUrl);
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
