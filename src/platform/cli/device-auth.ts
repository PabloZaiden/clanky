import { createJsonFileStore, type JsonFileStore, type JsonFileStoreLockOptions } from "./credentials";

export interface StoredDeviceCredentials {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  scope: string;
  accessTokenExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

type DeviceCredentialsStoreWrite = {
  write(value: StoredDeviceCredentials): Promise<void>;
};

type ReadableDeviceCredentialsStore = DeviceCredentialsStoreWrite & {
  read(): Promise<StoredDeviceCredentials | undefined>;
  withLock?: <T>(callback: () => Promise<T>, options?: JsonFileStoreLockOptions) => Promise<T>;
};

export type DeviceCredentialsStore =
  | (DeviceCredentialsStoreWrite & {
      read?: () => Promise<StoredDeviceCredentials | undefined>;
      withLock?: never;
    })
  | ReadableDeviceCredentialsStore;

export interface DeviceCredentialsForceRefresh {
  rejectedAccessToken: string;
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid base URL protocol: ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function parseStoredDeviceCredentials(value: unknown): StoredDeviceCredentials {
  if (!value || typeof value !== "object") {
    throw new Error("Stored credentials must be an object");
  }
  const record = value as Record<string, unknown>;
  const credentials = {
    baseUrl: String(record["baseUrl"] ?? ""),
    clientId: String(record["clientId"] ?? ""),
    accessToken: String(record["accessToken"] ?? ""),
    refreshToken: String(record["refreshToken"] ?? ""),
    tokenType: record["tokenType"],
    scope: String(record["scope"] ?? ""),
    accessTokenExpiresAt: String(record["accessTokenExpiresAt"] ?? ""),
    createdAt: String(record["createdAt"] ?? ""),
    updatedAt: String(record["updatedAt"] ?? ""),
  };
  if (!credentials.baseUrl || !credentials.clientId || !credentials.accessToken || !credentials.refreshToken || credentials.tokenType !== "Bearer") {
    throw new Error("Stored credentials are invalid");
  }
  return credentials as StoredDeviceCredentials;
}

export function createDeviceCredentialsStore(input: {
  appDirectoryName: string;
  envHome?: string;
  fileName?: string;
  home?: string;
  stateDirectory?: () => string;
}): JsonFileStore<StoredDeviceCredentials> {
  return createJsonFileStore({
    appDirectoryName: input.appDirectoryName,
    fileName: input.fileName ?? "device-auth.json",
    envHome: input.envHome,
    home: input.home,
    stateDirectory: input.stateDirectory,
    parse: parseStoredDeviceCredentials,
  });
}

export function getAuthorizedHeaders(credentials: StoredDeviceCredentials, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("authorization", `${credentials.tokenType} ${credentials.accessToken}`);
  return result;
}

function isExpired(credentials: StoredDeviceCredentials, now: Date): boolean {
  return new Date(credentials.accessTokenExpiresAt).getTime() <= now.getTime();
}

async function requestJson(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const response = await fetchFn(url, { ...init, headers });
  const text = await response.text();
  if (!text) {
    return { response, body: undefined };
  }
  try {
    return { response, body: JSON.parse(text) as unknown };
  } catch {
    return { response, body: text };
  }
}

function tokenError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return String(record["error_description"] ?? record["message"] ?? record["error"] ?? `Request failed with status ${status}`);
  }
  return `Request failed with status ${status}`;
}

function tokenCredentials(baseUrl: string, clientId: string, tokenSet: unknown, now: Date): StoredDeviceCredentials {
  if (!tokenSet || typeof tokenSet !== "object" || Array.isArray(tokenSet)) {
    throw new Error("Token response is invalid");
  }
  const record = tokenSet as Record<string, unknown>;
  const accessToken = record["access_token"];
  const refreshToken = record["refresh_token"];
  const tokenType = record["token_type"];
  const expiresIn = record["expires_in"];
  const scope = record["scope"];
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    tokenType !== "Bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn < 0 ||
    (scope !== undefined && typeof scope !== "string")
  ) {
    throw new Error("Token response is invalid");
  }
  return {
    baseUrl,
    clientId,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    scope: scope ?? "",
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

async function refreshCredentialsOnce(
  credentials: StoredDeviceCredentials,
  store: DeviceCredentialsStore | undefined,
  fetchFn: typeof fetch,
  now: () => Date,
): Promise<StoredDeviceCredentials | undefined> {
  const issuedAt = now();
  const { response, body } = await requestJson(fetchFn, `${credentials.baseUrl}/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
    }),
  });
  if (!response.ok) {
    return undefined;
  }
  const next = tokenCredentials(credentials.baseUrl, credentials.clientId, body, issuedAt);
  await store?.write(next);
  return next;
}

export async function refreshDeviceCredentials(input: {
  credentials: StoredDeviceCredentials;
  store?: DeviceCredentialsStore;
  forceRefresh?: DeviceCredentialsForceRefresh;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): Promise<StoredDeviceCredentials | undefined> {
  const now = input.now ?? (() => new Date());
  if (!input.forceRefresh && !isExpired(input.credentials, now())) {
    return input.credentials;
  }
  const fetchFn = input.fetchFn ?? fetch;
  const store = input.store;
  if (store?.withLock) {
    return store.withLock(async () => {
      const current = await store.read();
      if (!current) {
        throw new Error("Credentials store is unavailable after acquiring refresh lock");
      }
      if (
        input.forceRefresh &&
        current.accessToken !== input.forceRefresh.rejectedAccessToken
      ) {
        return current;
      }
      if (!input.forceRefresh && !isExpired(current, now())) {
        return current;
      }
      return refreshCredentialsOnce(current, store, fetchFn, now);
    });
  }
  return refreshCredentialsOnce(input.credentials, store, fetchFn, now);
}

export async function runDeviceAuthCommand(input: {
  baseUrl: string;
  clientId: string;
  store: JsonFileStore<StoredDeviceCredentials>;
  scope?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  out?: (message: string) => void;
}): Promise<number> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? (() => new Date());
  const out = input.out ?? console.log;
  const start = await requestJson(fetchFn, `${baseUrl}/api/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: input.clientId, scope: input.scope }),
  });
  if (!start.response.ok) throw new Error(tokenError(start.body, start.response.status));
  const started = start.body as Record<string, unknown>;
  out(`Open: ${String(started["verification_uri_complete"] ?? started["verification_uri"])}`);
  out(`Code: ${String(started["user_code"] ?? "")}`);
  const interval = Number(started["interval"] ?? 5) * 1000;
  while (true) {
    await (input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(interval);
    const token = await requestJson(fetchFn, `${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: started["device_code"],
        client_id: input.clientId,
      }),
    });
    if (token.response.ok) {
      await input.store.write(tokenCredentials(baseUrl, input.clientId, token.body, now()));
      out(`Authenticated with ${baseUrl}`);
      return 0;
    }
    const error = (token.body as Record<string, unknown> | undefined)?.["error"];
    if (error === "authorization_pending" || error === "slow_down") continue;
    throw new Error(tokenError(token.body, token.response.status));
  }
}
