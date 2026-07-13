import {
  createJsonFileStore,
  getAuthorizedHeaders as getWebAppAuthorizedHeaders,
  normalizeBaseUrl,
  parseStoredDeviceCredentials,
  refreshDeviceCredentials,
  runDeviceAuthCommand,
  type JsonFileStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import { homedir } from "os";
import { z } from "zod";
import { formatCookieHeader, parseCookieHeader } from "./http-cookies";

const DEFAULT_SCOPE = "";
const DEFAULT_LOCAL_BASE_URL = "http://localhost:3000";
const CLI_STATE_DIRECTORY = ".clanky";
const CLI_CREDENTIALS_FILE = "cli-auth.json";

const AuthStatusResponseSchema = z.object({
  authenticated: z.boolean(),
  authKind: z.string().min(1),
  subject: z.string().nullable(),
  clientId: z.string().nullable(),
  scope: z.string().nullable(),
});

type FrameworkCredentials = StoredDeviceCredentials;

export type StoredCliCredentials = FrameworkCredentials & {
  cookies: string;
};

type CredentialWriteValue = FrameworkCredentials | StoredCliCredentials;

export interface AuthCommandOptions {
  baseUrl: string;
  clientId: string;
  cookies?: string;
}

export interface StatusCommandOptions {
  baseUrl?: string;
}

export type CliRequestAuthContext =
  | {
    kind: "bearer";
    credentials: StoredCliCredentials;
    baseUrl: string;
  }
  | {
    kind: "anonymous-local";
    baseUrl: string;
  };

export interface CliAuthDependencies {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  out: (message: string) => void;
  now: () => Date;
}

export interface CliStatusDependencies {
  fetchFn: typeof fetch;
  out: (message: string) => void;
  now: () => Date;
}

export interface CliCredentialsStore extends JsonFileStore<FrameworkCredentials> {
  read(): Promise<StoredCliCredentials | undefined>;
  write(value: CredentialWriteValue): Promise<void>;
}

function getRequestUrl(input: string | URL | Request): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function isLocalhostBaseUrl(baseUrl: string): boolean {
  const { hostname } = new URL(baseUrl);
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

export function normalizeBaseUrlValue(rawValue: string): string {
  try {
    return normalizeBaseUrl(rawValue);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid base URL")) {
      throw error;
    }
    throw new Error(`Invalid base URL: ${rawValue}`);
  }
}

export function normalizeCookieHeaderValue(rawValue?: string): string | undefined {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseCookieHeader(trimmed);
  const normalized = formatCookieHeader(parsed.cookies);
  if (!parsed.valid || !normalized) {
    throw new Error("Invalid value for --cookies");
  }

  return normalized;
}

function parseStoredCliCredentials(value: unknown): StoredCliCredentials {
  const credentials = parseStoredDeviceCredentials(value);
  const record = value as Record<string, unknown>;
  const cookies = record["cookies"];
  return {
    ...credentials,
    cookies: typeof cookies === "string" ? cookies : "",
  };
}

export function createCliCredentialsStore(defaultCookies?: string): CliCredentialsStore {
  const store = createJsonFileStore<StoredCliCredentials>({
    appDirectoryName: CLI_STATE_DIRECTORY,
    envHome: "CLANKY_CLI_HOME",
    fileName: CLI_CREDENTIALS_FILE,
    parse: parseStoredCliCredentials,
    home: process.env["HOME"]?.trim() || homedir().trim(),
  });

  return {
    path: store.path,
    read: store.read,
    async write(value: CredentialWriteValue) {
      const previous = await store.read();
      await store.write({
        ...value,
        cookies: "cookies" in value
          ? value.cookies
          : previous?.cookies ?? defaultCookies ?? "",
      });
    },
    clear: store.clear,
    withLock: store.withLock,
  };
}

export async function loadStoredCliCredentials(): Promise<StoredCliCredentials | null> {
  return await createCliCredentialsStore().read() ?? null;
}

export async function saveStoredCliCredentials(credentials: StoredCliCredentials): Promise<void> {
  await createCliCredentialsStore().write(credentials);
}

export function getAuthorizedHeaders(
  credentials: StoredCliCredentials,
  headers?: HeadersInit,
): Headers {
  const authorizedHeaders = getWebAppAuthorizedHeaders(credentials, headers);
  if (credentials.cookies) {
    authorizedHeaders.set("cookie", credentials.cookies);
  }
  return authorizedHeaders;
}

function withRequestHeaders(
  fetchFn: typeof fetch,
  cookies?: string,
): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", new URL(getRequestUrl(input)).origin);
    if (cookies) {
      headers.set("cookie", cookies);
    }
    return await fetchFn(input, { ...init, headers });
  };
  return Object.assign(wrapped, {
    preconnect: (url: string | URL, options?: Parameters<typeof fetch.preconnect>[1]) =>
      fetchFn.preconnect(url, options),
  });
}

export async function runAuthCommand(
  command: AuthCommandOptions,
  dependencies: CliAuthDependencies,
): Promise<number> {
  const baseUrl = normalizeBaseUrlValue(command.baseUrl);
  dependencies.out("Waiting for approval...");
  return await runDeviceAuthCommand({
    baseUrl,
    clientId: command.clientId,
    scope: DEFAULT_SCOPE,
    store: createCliCredentialsStore(command.cookies),
    fetchFn: withRequestHeaders(dependencies.fetchFn, command.cookies),
    sleep: dependencies.sleep,
    now: dependencies.now,
    out: dependencies.out,
  });
}

function getTokenErrorMessage(body: unknown, fallbackStatus: number): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const message = record["error_description"] ?? record["message"] ?? record["error"];
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return `Request failed with status ${String(fallbackStatus)}`;
}

async function requestJson(
  fetchFn: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
  cookies?: string,
): Promise<{ response: Response; body: unknown }> {
  const response = await withRequestHeaders(fetchFn, cookies)(input, init);
  const rawBody = await response.text();
  if (!rawBody) {
    return { response, body: undefined };
  }

  try {
    return { response, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { response, body: rawBody };
  }
}

export async function refreshStoredCredentials(
  credentials: StoredCliCredentials,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
  baseUrlOverride?: string,
): Promise<StoredCliCredentials | null> {
  const effectiveCredentials = baseUrlOverride
    ? { ...credentials, baseUrl: normalizeBaseUrlValue(baseUrlOverride) }
    : credentials;
  const store = createCliCredentialsStore(credentials.cookies);
  const refreshStore = baseUrlOverride
    ? {
      write: store.write,
    }
    : store;
  const refreshed = await refreshDeviceCredentials({
    credentials: effectiveCredentials,
    store: refreshStore,
    fetchFn: withRequestHeaders(dependencies.fetchFn, credentials.cookies),
    now: dependencies.now,
  });
  return refreshed
    ? { ...refreshed, cookies: credentials.cookies }
    : null;
}

export async function getValidatedCredentials(
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
): Promise<StoredCliCredentials | null> {
  const storedCredentials = await loadStoredCliCredentials();
  if (!storedCredentials) {
    return null;
  }

  if (!command.baseUrl && new Date(storedCredentials.accessTokenExpiresAt).getTime() > dependencies.now().getTime()) {
    return storedCredentials;
  }

  return await refreshStoredCredentials(storedCredentials, dependencies, command.baseUrl);
}

async function probeAnonymousLocalAuthStatus(
  baseUrl: string,
  dependencies: {
    fetchFn: typeof fetch;
  },
): Promise<boolean> {
  if (!isLocalhostBaseUrl(baseUrl)) {
    return false;
  }

  const { response, body } = await requestJson(
    dependencies.fetchFn,
    `${baseUrl}/api/auth/status`,
  );
  if (!response.ok) {
    return false;
  }

  const parsed = AuthStatusResponseSchema.safeParse(body);
  return parsed.success && parsed.data.authKind === "anonymous";
}

export async function getCliRequestAuthContext(
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
): Promise<CliRequestAuthContext | null> {
  const credentials = await getValidatedCredentials(command, dependencies);
  if (credentials) {
    return {
      kind: "bearer",
      credentials,
      baseUrl: credentials.baseUrl,
    };
  }

  const baseUrl = command.baseUrl ?? DEFAULT_LOCAL_BASE_URL;
  if (!await probeAnonymousLocalAuthStatus(baseUrl, dependencies)) {
    return null;
  }

  return {
    kind: "anonymous-local",
    baseUrl,
  };
}

async function probeAuthStatus(
  credentials: StoredCliCredentials,
  dependencies: {
    fetchFn: typeof fetch;
  },
): Promise<{ response: Response; body: unknown }> {
  return await requestJson(
    dependencies.fetchFn,
    `${credentials.baseUrl}/api/auth/status`,
    {
      headers: getAuthorizedHeaders(credentials),
    },
    credentials.cookies,
  );
}

export async function runStatusCommand(
  command: StatusCommandOptions,
  dependencies: CliStatusDependencies,
): Promise<number> {
  let credentials = await getValidatedCredentials(command, dependencies);
  if (!credentials) {
    dependencies.out("Not logged in.");
    return 1;
  }

  let probe = await probeAuthStatus(credentials, dependencies);
  if (probe.response.status === 401) {
    const refreshedCredentials = await refreshStoredCredentials(credentials, dependencies, command.baseUrl);
    if (!refreshedCredentials) {
      dependencies.out("Stored credentials are invalid.");
      return 1;
    }
    credentials = refreshedCredentials;
    probe = await probeAuthStatus(credentials, dependencies);
  }

  if (!probe.response.ok) {
    throw new Error(getTokenErrorMessage(probe.body, probe.response.status));
  }

  const authStatus = AuthStatusResponseSchema.parse(probe.body);
  const clientId = authStatus.clientId ?? credentials.clientId;
  dependencies.out(`Logged in to ${credentials.baseUrl} as ${clientId}.`);
  return 0;
}

export { getTokenErrorMessage };
export type { FrameworkCredentials as StoredDeviceCredentials };
