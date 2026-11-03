import {
  getAuthorizedHeaders,
  refreshDeviceCredentials,
  type DeviceCredentialsStore,
  type StoredDeviceCredentials,
} from "./device-auth";
import {
  resolveEnvironmentApiKeyAuth,
  type CliEnvironment,
} from "./environment-auth";

export type CliAuthSource = "device" | "environment" | "anonymous";

export interface ResolvedCliAuth {
  source: CliAuthSource;
  headers: Headers;
  baseUrl?: string;
  accessToken?: string;
}

export interface ResolveCliAuthOptions {
  credentials?: DeviceCredentialsStore & {
    read(): Promise<StoredDeviceCredentials | undefined>;
  };
  envPrefix?: string;
  environment?: CliEnvironment;
  explicitBaseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

function apiKeyHeaders(apiKey: string, headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("authorization", `Bearer ${apiKey}`);
  return result;
}

export async function resolveCliAuth(input: ResolveCliAuthOptions): Promise<ResolvedCliAuth> {
  const headers = new Headers();
  const stored = await input.credentials?.read();
  if (stored) {
    const refreshed = await refreshDeviceCredentials({
      credentials: stored,
      store: input.credentials,
      fetchFn: input.fetchFn,
      now: input.now,
    });
    if (refreshed) {
      return {
        source: "device",
        headers: getAuthorizedHeaders(refreshed, headers),
        baseUrl: refreshed.baseUrl,
        accessToken: refreshed.accessToken,
      };
    }
  }
  if (input.envPrefix) {
    const environmentAuth = resolveEnvironmentApiKeyAuth({
      envPrefix: input.envPrefix,
      explicitBaseUrl: input.explicitBaseUrl,
      environment: input.environment,
    });
    if (environmentAuth) {
      return {
        source: "environment",
        headers: apiKeyHeaders(environmentAuth.apiKey, headers),
        baseUrl: environmentAuth.baseUrl,
      };
    }
  }
  return { source: "anonymous", headers };
}

export async function forceRefreshCliAuth(
  input: ResolveCliAuthOptions & {
    rejectedAccessToken: string;
  },
): Promise<ResolvedCliAuth | undefined> {
  const stored = await input.credentials?.read();
  if (!stored) return undefined;
  const refreshed = await refreshDeviceCredentials({
    credentials: {
      ...stored,
    },
    store: input.credentials,
    forceRefresh: {
      rejectedAccessToken: input.rejectedAccessToken,
    },
    fetchFn: input.fetchFn,
    now: input.now,
  });
  if (!refreshed) return undefined;
  return {
    source: "device",
    headers: getAuthorizedHeaders(refreshed),
    baseUrl: refreshed.baseUrl,
    accessToken: refreshed.accessToken,
  };
}
