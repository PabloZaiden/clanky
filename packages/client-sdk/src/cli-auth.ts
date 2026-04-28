import { mkdir, rename, rm } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { z } from "zod";
import { formatCookieHeader, parseCookieHeader } from "./http-cookies";

const DEFAULT_SCOPE = "";
const CLI_STATE_DIRECTORY = ".ralpher";
const CLI_CREDENTIALS_FILE = "cli-auth.json";
const inFlightRefreshes = new Map<string, Promise<StoredCliCredentials | null>>();

const DeviceStartResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

const TokenSuccessResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
});

const TokenErrorResponseSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().min(1).optional(),
});

const AuthStatusResponseSchema = z.object({
  authenticated: z.literal(true),
  authKind: z.string().min(1),
  subject: z.string().nullable(),
  clientId: z.string().nullable(),
  scope: z.string().nullable(),
});

export interface AuthCommandOptions {
  baseUrl: string;
  clientId: string;
  cookies?: string;
}

export interface StatusCommandOptions {
  baseUrl?: string;
}

const StoredCliCredentialsSchema = z.object({
  baseUrl: z.string().url(),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  scope: z.string(),
  cookies: z.string().default(""),
  accessTokenExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredCliCredentials = z.infer<typeof StoredCliCredentialsSchema>;

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

function getRequestUrl(input: string | URL | Request): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

export function normalizeBaseUrlValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid base URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid base URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/+$/, "");
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

function getCliStateDir(): string {
  const explicitCliHome = process.env["RALPHER_CLI_HOME"]?.trim();
  if (explicitCliHome) {
    return explicitCliHome;
  }

  const resolvedHome = process.env["HOME"]?.trim() || homedir().trim();
  if (!resolvedHome) {
    throw new Error("Could not determine the CLI state directory. Set HOME or RALPHER_CLI_HOME.");
  }

  return join(resolvedHome, CLI_STATE_DIRECTORY);
}

function getCliCredentialsPath(): string {
  return join(getCliStateDir(), CLI_CREDENTIALS_FILE);
}

function getCliCredentialsTempPath(credentialsPath: string): string {
  return join(
    dirname(credentialsPath),
    `.${basename(credentialsPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
}

function getRefreshBaseUrl(credentials: StoredCliCredentials, baseUrlOverride?: string): string {
  return baseUrlOverride ?? credentials.baseUrl;
}

function getRefreshCacheKey(credentials: StoredCliCredentials, baseUrlOverride?: string): string {
  return JSON.stringify({
    baseUrl: getRefreshBaseUrl(credentials, baseUrlOverride),
    clientId: credentials.clientId,
    cookies: credentials.cookies,
    refreshToken: credentials.refreshToken,
  });
}

function hasCredentialStateChanged(current: StoredCliCredentials, previous: StoredCliCredentials): boolean {
  return current.baseUrl !== previous.baseUrl
    || current.clientId !== previous.clientId
    || current.accessToken !== previous.accessToken
    || current.refreshToken !== previous.refreshToken
    || current.tokenType !== previous.tokenType
    || current.scope !== previous.scope
    || current.cookies !== previous.cookies
    || current.accessTokenExpiresAt !== previous.accessTokenExpiresAt
    || current.updatedAt !== previous.updatedAt;
}

function isSameRefreshScope(
  current: StoredCliCredentials,
  previous: StoredCliCredentials,
  baseUrlOverride?: string,
): boolean {
  return current.baseUrl === getRefreshBaseUrl(previous, baseUrlOverride)
    && current.clientId === previous.clientId
    && current.cookies === previous.cookies;
}

async function getLatestStoredCredentialsForRefresh(
  credentials: StoredCliCredentials,
  baseUrlOverride?: string,
): Promise<{
  credentials: StoredCliCredentials;
  reusedStoredCredentials: boolean;
}> {
  const storedCredentials = await loadStoredCliCredentials();
  if (!storedCredentials || !isSameRefreshScope(storedCredentials, credentials, baseUrlOverride)) {
    return {
      credentials,
      reusedStoredCredentials: false,
    };
  }
  if (!hasCredentialStateChanged(storedCredentials, credentials)) {
    return {
      credentials,
      reusedStoredCredentials: false,
    };
  }
  return {
    credentials: storedCredentials,
    reusedStoredCredentials: true,
  };
}

async function requestJson(
  fetchFn: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("origin", new URL(getRequestUrl(input)).origin);

  const response = await fetchFn(input, {
    ...init,
    headers,
  });
  const rawBody = await response.text();
  if (!rawBody) {
    return {
      response,
      body: undefined,
    };
  }

  try {
    return {
      response,
      body: JSON.parse(rawBody) as unknown,
    };
  } catch {
    throw new Error(`Expected a JSON response from ${input}`);
  }
}

export function getTokenErrorMessage(body: unknown, fallbackStatus: number): string {
  const parsed = TokenErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return parsed.data.error_description ?? parsed.data.error;
  }
  return `Request failed with status ${String(fallbackStatus)}`;
}

function createStoredCredentials(
  command: AuthCommandOptions,
  tokenSet: z.infer<typeof TokenSuccessResponseSchema>,
  now: Date,
): StoredCliCredentials {
  return {
    baseUrl: command.baseUrl,
    clientId: command.clientId,
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    tokenType: tokenSet.token_type,
    scope: tokenSet.scope || DEFAULT_SCOPE,
    cookies: command.cookies ?? "",
    accessTokenExpiresAt: new Date(now.getTime() + tokenSet.expires_in * 1000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function loadStoredCliCredentials(): Promise<StoredCliCredentials | null> {
  const credentialsFile = Bun.file(getCliCredentialsPath());
  if (!await credentialsFile.exists()) {
    return null;
  }

  const rawCredentials = await credentialsFile.text();
  try {
    return StoredCliCredentialsSchema.parse(JSON.parse(rawCredentials) as unknown);
  } catch (error) {
    throw new Error(`Failed to read stored CLI credentials: ${String(error)}`);
  }
}

export async function saveStoredCliCredentials(credentials: StoredCliCredentials): Promise<void> {
  const stateDir = getCliStateDir();
  const credentialsPath = join(stateDir, CLI_CREDENTIALS_FILE);
  const tempPath = getCliCredentialsTempPath(credentialsPath);
  const serializedCredentials = `${JSON.stringify(StoredCliCredentialsSchema.parse(credentials), null, 2)}\n`;

  await mkdir(stateDir, { recursive: true });
  try {
    await Bun.write(tempPath, serializedCredentials);
    await rename(tempPath, credentialsPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function getAuthorizedHeaders(
  credentials: StoredCliCredentials,
  headers?: HeadersInit,
): Headers {
  const authorizedHeaders = new Headers(headers);
  authorizedHeaders.set("authorization", `${credentials.tokenType} ${credentials.accessToken}`);
  if (credentials.cookies) {
    authorizedHeaders.set("cookie", credentials.cookies);
  }
  return authorizedHeaders;
}

export async function runAuthCommand(
  command: AuthCommandOptions,
  dependencies: CliAuthDependencies,
): Promise<number> {
  const cookieHeader = command.cookies;
  const { response, body } = await requestJson(
    dependencies.fetchFn,
    `${command.baseUrl}/api/auth/device`,
    {
      method: "POST",
      headers: {
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: command.clientId,
        scope: DEFAULT_SCOPE,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(getTokenErrorMessage(body, response.status));
  }

  const start = DeviceStartResponseSchema.parse(body);
  dependencies.out(`Open: ${start.verification_uri_complete}`);
  dependencies.out(`Code: ${start.user_code}`);
  dependencies.out("Waiting for approval...");

  let pollIntervalMs = start.interval * 1000;
  while (true) {
    await dependencies.sleep(pollIntervalMs);

    const tokenResult = await requestJson(
      dependencies.fetchFn,
      `${command.baseUrl}/api/auth/token`,
      {
        method: "POST",
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: start.device_code,
          client_id: command.clientId,
        }),
      },
    );

    if (tokenResult.response.ok) {
      const tokenSet = TokenSuccessResponseSchema.parse(tokenResult.body);
      await saveStoredCliCredentials(createStoredCredentials(command, tokenSet, dependencies.now()));
      dependencies.out(`Authenticated with ${command.baseUrl}`);
      return 0;
    }

    const tokenError = TokenErrorResponseSchema.safeParse(tokenResult.body);
    if (!tokenError.success) {
      throw new Error(`Unexpected token response status ${String(tokenResult.response.status)}`);
    }

    if (tokenError.data.error === "authorization_pending") {
      continue;
    }
    if (tokenError.data.error === "slow_down") {
      pollIntervalMs += 5000;
      continue;
    }

    throw new Error(tokenError.data.error_description ?? tokenError.data.error);
  }
}

function createUpdatedStoredCredentials(
  existing: StoredCliCredentials,
  tokenSet: z.infer<typeof TokenSuccessResponseSchema>,
  now: Date,
  baseUrlOverride?: string,
): StoredCliCredentials {
  return {
    ...existing,
    baseUrl: baseUrlOverride ?? existing.baseUrl,
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    tokenType: tokenSet.token_type,
    scope: tokenSet.scope,
    cookies: existing.cookies,
    accessTokenExpiresAt: new Date(now.getTime() + tokenSet.expires_in * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function isAccessTokenExpired(credentials: StoredCliCredentials, now: Date): boolean {
  return new Date(credentials.accessTokenExpiresAt).getTime() <= now.getTime();
}

export async function refreshStoredCredentials(
  credentials: StoredCliCredentials,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
  baseUrlOverride?: string,
): Promise<StoredCliCredentials | null> {
  const now = dependencies.now();
  const {
    credentials: activeCredentials,
    reusedStoredCredentials,
  } = await getLatestStoredCredentialsForRefresh(credentials, baseUrlOverride);
  if (reusedStoredCredentials && !isAccessTokenExpired(activeCredentials, now)) {
    return activeCredentials;
  }

  const refreshKey = getRefreshCacheKey(activeCredentials, baseUrlOverride);
  const existingRefresh = inFlightRefreshes.get(refreshKey);
  if (existingRefresh) {
    return await existingRefresh;
  }

  const refreshPromise = (async (): Promise<StoredCliCredentials | null> => {
    const baseUrl = getRefreshBaseUrl(activeCredentials, baseUrlOverride);
    const cookieHeader = activeCredentials.cookies || undefined;
    const { response, body } = await requestJson(
      dependencies.fetchFn,
      `${baseUrl}/api/auth/token`,
      {
        method: "POST",
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: activeCredentials.refreshToken,
          client_id: activeCredentials.clientId,
        }),
      },
    );

    if (!response.ok) {
      const tokenError = TokenErrorResponseSchema.safeParse(body);
      if (tokenError.success && (tokenError.data.error === "invalid_grant" || tokenError.data.error === "invalid_client")) {
        return null;
      }
      throw new Error(getTokenErrorMessage(body, response.status));
    }

    const tokenSet = TokenSuccessResponseSchema.parse(body);
    const refreshedCredentials = createUpdatedStoredCredentials(
      activeCredentials,
      tokenSet,
      now,
      baseUrlOverride,
    );
    await saveStoredCliCredentials(refreshedCredentials);
    return refreshedCredentials;
  })();

  inFlightRefreshes.set(refreshKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (inFlightRefreshes.get(refreshKey) === refreshPromise) {
      inFlightRefreshes.delete(refreshKey);
    }
  }
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

  if (!isAccessTokenExpired(storedCredentials, dependencies.now()) && !command.baseUrl) {
    return storedCredentials;
  }

  return await refreshStoredCredentials(storedCredentials, dependencies, command.baseUrl);
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
