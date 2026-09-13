/**
 * Shared authenticated HTTP helpers for Clanky CLI commands.
 */

import {
  getAuthorizedHeaders,
  normalizeBaseUrl,
  refreshDeviceCredentials,
  resolveEnvironmentApiKeyAuth,
  type CliEnvironment,
  type DeviceCredentialsStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";

export interface CliApiContext {
  fetchFn: typeof fetch;
  environment: CliEnvironment;
  envPrefix: string;
  credentials: DeviceCredentialsStore & {
    read(): Promise<StoredDeviceCredentials | undefined>;
  };
}

export interface CliApiAuth {
  baseUrl: string;
  headers: Headers;
  source: "device" | "environment" | "anonymous";
  accessToken?: string;
}

export async function resolveCliApiAuth(input: CliApiContext): Promise<CliApiAuth> {
  const stored = await input.credentials.read();
  if (stored) {
    const refreshed = await refreshDeviceCredentials({
      credentials: stored,
      store: input.credentials,
      fetchFn: input.fetchFn,
    });
    if (refreshed) {
      return {
        baseUrl: refreshed.baseUrl,
        headers: getAuthorizedHeaders(refreshed),
        source: "device",
        accessToken: refreshed.accessToken,
      };
    }
  }

  const environmentAuth = resolveEnvironmentApiKeyAuth({
    envPrefix: input.envPrefix,
    environment: input.environment,
  });
  if (environmentAuth) {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${environmentAuth.apiKey}`);
    return {
      baseUrl: environmentAuth.baseUrl,
      headers,
      source: "environment",
    };
  }

  const rawBaseUrl = input.environment[`${input.envPrefix}_BASE_URL`] ?? "http://localhost:3000";
  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    headers: new Headers(),
    source: "anonymous",
  };
}

export async function fetchCliApi(
  input: CliApiContext,
  auth: CliApiAuth,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = () => input.fetchFn(new URL(path, `${auth.baseUrl}/`), {
    ...init,
    headers: new Headers({
      ...Object.fromEntries(auth.headers.entries()),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    }),
  });
  let response = await send();
  if (response.status === 401 && auth.source === "device" && auth.accessToken) {
    const stored = await input.credentials.read();
    const refreshed = stored
      ? await refreshDeviceCredentials({
        credentials: stored,
        store: input.credentials,
        forceRefresh: { rejectedAccessToken: auth.accessToken },
        fetchFn: input.fetchFn,
      })
      : undefined;
    if (refreshed) {
      auth.headers = getAuthorizedHeaders(refreshed);
      auth.accessToken = refreshed.accessToken;
      response = await send();
    }
  }
  return response;
}

export async function readCliResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function responseErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
    if (typeof record["error"] === "string") return record["error"];
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
}
