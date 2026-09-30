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
import { z } from "zod";

export interface CliApiContext {
  fetchFn: typeof fetch;
  environment: CliEnvironment;
  envPrefix: string;
  validateBaseUrl?: (baseUrl: string) => void;
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

export async function resolveCliWorkspace(input: CliApiContext, auth: CliApiAuth, reference: string, signal?: AbortSignal) {
  const response = await fetchCliApi(input, auth, "/api/workspaces", { signal, redirect: "error" });
  const body = await readCliResponseBody(response);
  if (!response.ok) throw new Error(responseErrorMessage(body, `Unable to list workspaces (HTTP ${String(response.status)})`));
  const parsed = z.array(z.object({ id: z.string(), name: z.string(), directory: z.string() })).safeParse(body);
  if (!parsed.success) throw new Error("The workspace list response is invalid");
  const byId = parsed.data.find((entry) => entry.id === reference);
  if (byId) return byId;
  const byName = parsed.data.filter((entry) => entry.name === reference);
  if (byName.length === 1) return byName[0]!;
  throw new Error(byName.length > 1 ? `Workspace name is ambiguous: ${reference}` : `Workspace not found: ${reference}`);
}

function abortableFetch(fetchFn: typeof fetch, signal?: AbortSignal): typeof fetch {
  if (!signal) return fetchFn;
  return Object.assign(
    (resource: Parameters<typeof fetch>[0], init?: RequestInit) => fetchFn(resource, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }),
    { preconnect: fetchFn.preconnect },
  );
}

export async function resolveCliApiAuth(input: CliApiContext, signal?: AbortSignal): Promise<CliApiAuth> {
  const stored = await input.credentials.read();
  if (stored) {
    input.validateBaseUrl?.(stored.baseUrl);
    const refreshed = await refreshDeviceCredentials({
      credentials: stored,
      store: input.credentials,
      fetchFn: abortableFetch(input.fetchFn, signal),
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
    input.validateBaseUrl?.(environmentAuth.baseUrl);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${environmentAuth.apiKey}`);
    return {
      baseUrl: environmentAuth.baseUrl,
      headers,
      source: "environment",
    };
  }

  const rawBaseUrl = input.environment[`${input.envPrefix}_BASE_URL`] ?? "http://localhost:3000";
  input.validateBaseUrl?.(rawBaseUrl);
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
    if (stored) input.validateBaseUrl?.(stored.baseUrl);
    const refreshed = stored
      ? await refreshDeviceCredentials({
        credentials: stored,
        store: input.credentials,
        forceRefresh: { rejectedAccessToken: auth.accessToken },
        fetchFn: abortableFetch(input.fetchFn, init.signal ?? undefined),
      })
      : undefined;
    if (refreshed) {
      auth.headers = getAuthorizedHeaders(refreshed);
      auth.accessToken = refreshed.accessToken;
      // A streamed body is consumed by the first request and cannot be replayed.
      if (!(init.body instanceof ReadableStream)) response = await send();
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
