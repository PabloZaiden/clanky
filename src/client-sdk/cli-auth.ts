import {
  createJsonFileStore,
  getAuthorizedHeaders as getWebAppAuthorizedHeaders,
  normalizeBaseUrl,
  parseStoredDeviceCredentials,
  refreshDeviceCredentials,
  resolveEnvironmentApiKeyAuth,
  runDeviceAuthCommand,
  type CliEnvironment,
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
  profile?: string;
}

export interface StatusCommandOptions {
  baseUrl?: string;
  profile?: string;
}

export type CliRequestAuthContext =
  | {
    kind: "bearer";
    credentials: StoredCliCredentials;
    baseUrl: string;
  }
  | {
    kind: "environment";
    apiKey: string;
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
  environment?: CliEnvironment;
}

export interface CliCredentialsStore extends JsonFileStore<FrameworkCredentials> {
  read(): Promise<StoredCliCredentials | undefined>;
  write(value: CredentialWriteValue): Promise<void>;
}

interface CliAuthFile {
  version: 2;
  activeProfile: string;
  profiles: Record<string, StoredCliCredentials>;
}

export interface CliProfileInfo {
  name: string;
  baseUrl: string;
  active: boolean;
}

function getRequestUrl(input: string | URL | Request): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

export function mergeRequestHeaders(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  return headers;
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
  } catch {
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

function normalizeProfileName(profileName: string): string {
  const normalized = profileName.trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/")) {
    throw new Error("Invalid CLI profile name");
  }
  return normalized;
}

function parseCliAuthFile(value: unknown): CliAuthFile {
  if (
    typeof value === "object"
    && value !== null
    && "profiles" in value
    && typeof value["profiles"] === "object"
    && value["profiles"] !== null
  ) {
    const record = value as Record<string, unknown>;
    const rawProfiles = record["profiles"] as Record<string, unknown>;
    const profiles: Record<string, StoredCliCredentials> = {};
    for (const [name, rawCredentials] of Object.entries(rawProfiles)) {
      profiles[normalizeProfileName(name)] = parseStoredCliCredentials(rawCredentials);
    }
    const rawActiveProfile = record["activeProfile"];
    const activeProfile = typeof rawActiveProfile === "string" && rawActiveProfile.trim()
      ? normalizeProfileName(rawActiveProfile)
      : "default";
    return {
      version: 2,
      activeProfile,
      profiles,
    };
  }

  return {
    version: 2,
    activeProfile: "default",
    profiles: {
      default: parseStoredCliCredentials(value),
    },
  };
}

function createCliAuthFileStore(): JsonFileStore<CliAuthFile> {
  return createJsonFileStore<CliAuthFile>({
    appDirectoryName: CLI_STATE_DIRECTORY,
    envHome: "CLANKY_CLI_HOME",
    fileName: CLI_CREDENTIALS_FILE,
    parse: parseCliAuthFile,
    home: process.env["HOME"]?.trim() || homedir().trim(),
  });
}

export function createCliCredentialsStore(
  defaultCookies?: string,
  profileName?: string,
): CliCredentialsStore {
  const store = createCliAuthFileStore();
  const selectedProfile = profileName ? normalizeProfileName(profileName) : undefined;

  return {
    path: store.path,
    async read() {
      const file = await store.read();
      if (!file) {
        return undefined;
      }
      return file.profiles[selectedProfile ?? file.activeProfile];
    },
    async write(value: CredentialWriteValue) {
      const file = await store.read() ?? {
        version: 2 as const,
        activeProfile: selectedProfile ?? "default",
        profiles: {},
      };
      const targetProfile = selectedProfile ?? file.activeProfile;
      const previous = file.profiles[targetProfile];
      file.profiles[targetProfile] = {
        ...value,
        cookies: "cookies" in value
          ? value.cookies
          : previous?.cookies ?? defaultCookies ?? "",
      };
      await store.write(file);
    },
    async clear() {
      const file = await store.read();
      if (!file) {
        return;
      }
      const targetProfile = selectedProfile ?? file.activeProfile;
      delete file.profiles[targetProfile];
      if (file.activeProfile === targetProfile) {
        file.activeProfile = Object.keys(file.profiles)[0] ?? "default";
      }
      await store.write(file);
    },
    withLock: store.withLock,
  };
}

export async function loadStoredCliCredentials(profileName?: string): Promise<StoredCliCredentials | null> {
  return await createCliCredentialsStore(undefined, profileName).read() ?? null;
}

export async function saveStoredCliCredentials(
  credentials: StoredCliCredentials,
  profileName?: string,
): Promise<void> {
  await createCliCredentialsStore(undefined, profileName).write(credentials);
}

export async function listCliProfiles(): Promise<CliProfileInfo[]> {
  const file = await createCliAuthFileStore().read();
  if (!file) {
    return [];
  }
  return Object.entries(file.profiles)
    .map(([name, credentials]) => ({
      name,
      baseUrl: credentials.baseUrl,
      active: name === file.activeProfile,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function useCliProfile(profileName: string): Promise<void> {
  const normalized = normalizeProfileName(profileName);
  const store = createCliAuthFileStore();
  const file = await store.read();
  if (!file?.profiles[normalized]) {
    throw new Error(`CLI profile not found: ${normalized}`);
  }
  file.activeProfile = normalized;
  await store.write(file);
}

export async function removeCliProfile(profileName: string): Promise<void> {
  const normalized = normalizeProfileName(profileName);
  const store = createCliAuthFileStore();
  const file = await store.read();
  if (!file?.profiles[normalized]) {
    throw new Error(`CLI profile not found: ${normalized}`);
  }
  delete file.profiles[normalized];
  if (file.activeProfile === normalized) {
    file.activeProfile = Object.keys(file.profiles)[0] ?? "default";
  }
  await store.write(file);
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

export function getAuthContextHeaders(
  authContext: CliRequestAuthContext,
  headers?: HeadersInit,
): Headers {
  if (authContext.kind === "bearer") {
    return getAuthorizedHeaders(authContext.credentials, headers);
  }

  const authorizedHeaders = new Headers(headers);
  if (authContext.kind === "environment") {
    authorizedHeaders.set("authorization", `Bearer ${authContext.apiKey}`);
  }
  return authorizedHeaders;
}

function withRequestHeaders(
  fetchFn: typeof fetch,
  cookies?: string,
): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = mergeRequestHeaders(input, init);
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
    store: createCliCredentialsStore(command.cookies, command.profile),
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
  profileName?: string,
): Promise<StoredCliCredentials | null> {
  const effectiveCredentials = baseUrlOverride
    ? { ...credentials, baseUrl: normalizeBaseUrlValue(baseUrlOverride) }
    : credentials;
  const store = createCliCredentialsStore(credentials.cookies, profileName);
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

async function validateStoredCredentials(
  storedCredentials: StoredCliCredentials,
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
): Promise<StoredCliCredentials | null> {
  if (!command.baseUrl && new Date(storedCredentials.accessTokenExpiresAt).getTime() > dependencies.now().getTime()) {
    return storedCredentials;
  }

  return await refreshStoredCredentials(storedCredentials, dependencies, command.baseUrl, command.profile);
}

export async function getValidatedCredentials(
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
): Promise<StoredCliCredentials | null> {
  const storedCredentials = await loadStoredCliCredentials(command.profile);
  if (!storedCredentials) {
    return null;
  }

  return await validateStoredCredentials(storedCredentials, command, dependencies);
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

type CliCredentialAuthContext = Exclude<CliRequestAuthContext, { kind: "anonymous-local" }>;

async function getCliCredentialAuthContext(
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
    environment?: CliEnvironment;
  },
): Promise<CliCredentialAuthContext | null> {
  const storedCredentials = await loadStoredCliCredentials(command.profile);
  if (storedCredentials) {
    const credentials = await validateStoredCredentials(storedCredentials, command, dependencies);
    return credentials
      ? {
        kind: "bearer",
        credentials,
        baseUrl: credentials.baseUrl,
      }
      : null;
  }

  const environmentAuth = resolveEnvironmentApiKeyAuth({
    envPrefix: "CLANKY",
    explicitBaseUrl: command.baseUrl,
    environment: dependencies.environment,
  });
  if (!environmentAuth) {
    return null;
  }

  return {
    kind: "environment",
    apiKey: environmentAuth.apiKey,
    baseUrl: environmentAuth.baseUrl,
  };
}

export async function getCliRequestAuthContext(
  command: StatusCommandOptions,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
    environment?: CliEnvironment;
  },
): Promise<CliRequestAuthContext | null> {
  const credentialContext = await getCliCredentialAuthContext(command, dependencies);
  if (credentialContext) {
    return credentialContext;
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
  authContext: CliCredentialAuthContext,
  dependencies: {
    fetchFn: typeof fetch;
  },
): Promise<{ response: Response; body: unknown }> {
  return await requestJson(
    dependencies.fetchFn,
    `${authContext.baseUrl}/api/auth/status`,
    {
      headers: getAuthContextHeaders(authContext),
    },
    authContext.kind === "bearer" ? authContext.credentials.cookies : undefined,
  );
}

export async function runStatusCommand(
  command: StatusCommandOptions,
  dependencies: CliStatusDependencies,
): Promise<number> {
  let authContext = await getCliCredentialAuthContext(command, dependencies);
  if (!authContext) {
    dependencies.out("Not logged in.");
    return 1;
  }

  let probe = await probeAuthStatus(authContext, dependencies);
  if (probe.response.status === 401 && authContext.kind === "bearer") {
    const refreshedCredentials = await refreshStoredCredentials(
      authContext.credentials,
      dependencies,
      command.baseUrl,
      command.profile,
    );
    if (!refreshedCredentials) {
      dependencies.out("Stored credentials are invalid.");
      return 1;
    }
    authContext = {
      kind: "bearer",
      credentials: refreshedCredentials,
      baseUrl: refreshedCredentials.baseUrl,
    };
    probe = await probeAuthStatus(authContext, dependencies);
  }

  if (!probe.response.ok) {
    throw new Error(getTokenErrorMessage(probe.body, probe.response.status));
  }

  const authStatus = AuthStatusResponseSchema.parse(probe.body);
  if (!authStatus.authenticated) {
    dependencies.out("Authentication was not accepted.");
    return 1;
  }

  if (authContext.kind === "environment") {
    dependencies.out(`Authenticated via environment variables at ${authContext.baseUrl}.`);
    return 0;
  }

  const clientId = authStatus.clientId ?? authContext.credentials.clientId;
  dependencies.out(`Logged in to ${authContext.baseUrl} as ${clientId}.`);
  return 0;
}

export { getTokenErrorMessage };
export type { FrameworkCredentials as StoredDeviceCredentials };
