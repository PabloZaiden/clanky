/**
 * Terminal entrypoint for `ralpher cli`.
 */

import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { formatCookieHeader, parseCookieHeader } from "../lib/http-cookies";

const DEFAULT_CLIENT_ID = "ralpher-cli";
const DEFAULT_SCOPE = "";
const CLI_STATE_DIRECTORY = ".ralpher";
const CLI_CREDENTIALS_FILE = "cli-auth.json";

const CLI_USAGE = [
  "Usage:",
  "  ralpher cli auth --base-url <url> [--client-id <client-id>] [--cookies <cookie-header>]",
  "  ralpher cli status [--base-url <url>]",
].join("\n");

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

export type CliCommand =
  | {
    action: "auth";
    baseUrl: string;
    clientId: string;
    cookies?: string;
  }
  | {
    action: "status";
    baseUrl?: string;
  };

function normalizeBaseUrl(rawValue?: string): string {
  const trimmed = rawValue?.trim() || process.env["RALPHER_BASE_URL"]?.trim();
  if (!trimmed) {
    throw new Error(`Missing value for --base-url\n\n${CLI_USAGE}`);
  }
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

function getRequestUrl(input: string | URL | Request): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
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

function parseOptionValue(option: string, rawValue?: string): string {
  if (!rawValue?.trim() || rawValue.startsWith("--")) {
    throw new Error(`Missing value for ${option}\n\n${CLI_USAGE}`);
  }
  return rawValue.trim();
}

function normalizeCookieOption(rawValue?: string): string | undefined {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = formatCookieHeader(parseCookieHeader(trimmed));
  if (!normalized) {
    throw new Error(`Invalid value for --cookies\n\n${CLI_USAGE}`);
  }

  return normalized;
}

function parseCliOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}\n\n${CLI_USAGE}`);
    }

    const [name, inlineValue] = arg.split("=", 2);
    if (name !== "--base-url" && name !== "--client-id" && name !== "--cookies") {
      throw new Error(`Unknown option: ${name}\n\n${CLI_USAGE}`);
    }

    const value = inlineValue ?? args[index + 1];
    options[name] = parseOptionValue(name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return options;
}

export function parseCliCommand(args: string[]): CliCommand {
  const [action, ...restArgs] = args;
  if (!action) {
    throw new Error(`Missing CLI command.\n\n${CLI_USAGE}`);
  }
  const options = parseCliOptions(restArgs);
  if (action === "auth") {
    return {
      action,
      baseUrl: normalizeBaseUrl(options["--base-url"]),
      clientId: options["--client-id"]?.trim() || DEFAULT_CLIENT_ID,
      cookies: normalizeCookieOption(options["--cookies"]),
    };
  }
  if (action === "status") {
    return {
      action,
      baseUrl: options["--base-url"] ? normalizeBaseUrl(options["--base-url"]) : undefined,
    };
  }
  throw new Error(`Unknown CLI command: ${action}\n\n${CLI_USAGE}`);
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

function getTokenErrorMessage(body: unknown, fallbackStatus: number): string {
  const parsed = TokenErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return parsed.data.error_description ?? parsed.data.error;
  }
  return `Request failed with status ${String(fallbackStatus)}`;
}

function createStoredCredentials(
  command: Extract<CliCommand, { action: "auth" }>,
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
  await mkdir(getCliStateDir(), { recursive: true });
  await Bun.write(
    getCliCredentialsPath(),
    `${JSON.stringify(StoredCliCredentialsSchema.parse(credentials), null, 2)}\n`,
  );
}

async function runAuthCommand(
  command: Extract<CliCommand, { action: "auth" }>,
  dependencies: {
    fetchFn: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    out: (message: string) => void;
    now: () => Date;
  },
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

async function refreshStoredCredentials(
  credentials: StoredCliCredentials,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
  },
  baseUrlOverride?: string,
): Promise<StoredCliCredentials | null> {
  const baseUrl = baseUrlOverride ?? credentials.baseUrl;
  const cookieHeader = credentials.cookies || undefined;
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
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
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
    credentials,
    tokenSet,
    dependencies.now(),
    baseUrlOverride,
  );
  await saveStoredCliCredentials(refreshedCredentials);
  return refreshedCredentials;
}

async function getValidatedCredentials(
  command: Extract<CliCommand, { action: "status" }>,
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
  const cookieHeader = credentials.cookies || undefined;
  return await requestJson(
    dependencies.fetchFn,
    `${credentials.baseUrl}/api/auth/status`,
    {
      headers: {
        authorization: `${credentials.tokenType} ${credentials.accessToken}`,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    },
  );
}

async function runStatusCommand(
  command: Extract<CliCommand, { action: "status" }>,
  dependencies: {
    fetchFn: typeof fetch;
    now: () => Date;
    out: (message: string) => void;
  },
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

export async function runCli(
  args: string[],
  dependencies: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    out?: (message: string) => void;
    err?: (message: string) => void;
  } = {},
): Promise<number> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;

  try {
    const command = parseCliCommand(args);
    if (command.action === "auth") {
      return await runAuthCommand(command, {
        fetchFn,
        sleep,
        out,
        now,
      });
    }

    return await runStatusCommand(command, {
      fetchFn,
      now,
      out,
    });
  } catch (error) {
    err(String(error));
    return 1;
  }
}
