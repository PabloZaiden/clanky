import {
  appJson,
  appPath,
  appWebSocketUrl,
  configureWebAppClient,
  fetchAppRequest,
  getWebAppClientMode,
  nativeWebAppDuplex,
  validateExternalSession,
  type WebAppClientOptions,
  type WebAppResourceUrl,
} from "@pablozaiden/webapp/web";
import {
  clientAccessToken,
  configureExternalClientStorageScope,
  configureRemoteClient,
  getClientSession,
  type WebAppRemoteClientOptions,
} from "./client-session";
import { clankyClientRuntime } from "./runtime";

export {
  appAbsoluteUrl,
  appDuplexConnection,
  appFetch,
  appJson,
  appJsonWithMetadata,
  appPagePath,
  appPath,
  appRequest,
  appResourceUrl,
  appSaveResource,
  appWebSocketConnection,
  appWebSocketUrl,
  getClientConnectionPickerUrl,
  getWebAppClientMode,
  getWebAppClientVersion,
  getWebAppExternalClient,
  getWebAppPublicBasePath,
  isWebAppPublicBasePath,
  setWebAppPublicBasePath,
  WebAppApiError,
  type WebAppResourceUrl,
} from "@pablozaiden/webapp/web";

const authRequiredListeners = new Set<() => void>();

export function onAuthRequired(listener: () => void): () => void {
  authRequiredListeners.add(listener);
  return () => { authRequiredListeners.delete(listener); };
}

function selectedApiUrl(url: URL): URL {
  const endpoint = getClientSession().endpoint;
  if (!endpoint) throw new Error("Choose an API server first.");
  const base = new URL(`${endpoint}/`);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error("Refusing to send server credentials to a different API endpoint.");
  }
  return base;
}

async function authenticatedRequest(request: Request): Promise<Response> {
  if (!getClientSession().enabled) return await fetchAppRequest(request);
  selectedApiUrl(new URL(request.url));
  const retry = request.clone();
  const accessToken = await clientAccessToken();
  const send = async (source: Request, token: string) => {
    const headers = new Headers(source.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await fetchAppRequest(new Request(source, { headers, credentials: "omit", redirect: "error" }));
  };
  const response = await send(request, accessToken);
  if (response.status !== 401) return response;
  let failure: unknown;
  try {
    failure = await response.clone().json();
  } catch {
    // Only the server's explicit authentication rejection permits replay.
    return response;
  }
  if (typeof failure !== "object" || failure === null || !("error" in failure)
    || !["invalid_token", "authentication_required"].includes(String(failure.error))) return response;
  const token = await clientAccessToken(accessToken);
  await response.body?.cancel();
  return await send(retry, token);
}

async function request(request: Request): Promise<Response> {
  const response = await authenticatedRequest(request);
  if (response.headers.get("x-webapp-passkey-required") === "true"
    || response.headers.get("x-passkey-auth-required") === "true") {
    for (const listener of authRequiredListeners) listener();
  }
  return response;
}

async function resourceUrl(
  path: string,
  options: { signal?: AbortSignal; kind?: "resource" | "websocket" } = {},
): Promise<WebAppResourceUrl> {
  const kind = options.kind ?? "resource";
  const url = new URL(kind === "websocket" ? appWebSocketUrl(path) : appPath(path));
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  const base = selectedApiUrl(url);
  const target = `/${url.pathname.slice(base.pathname.length).replace(/^\/+/, "")}${url.search}`;
  const response = await appJson<unknown>("/api/auth/client-ticket", {
    method: "POST",
    body: JSON.stringify({ url: target, kind }),
    signal: options.signal,
  });
  if (!response || typeof response !== "object" || !("url" in response) || !("expiresAt" in response)
    || typeof response.url !== "string" || typeof response.expiresAt !== "number"
    || !Number.isFinite(response.expiresAt) || response.expiresAt <= Date.now()) {
    throw new Error("The server returned an invalid client resource ticket.");
  }
  const resource = new URL(response.url.replace(/^\/+/, ""), base);
  selectedApiUrl(resource);
  if (kind === "websocket") resource.protocol = resource.protocol === "https:" ? "wss:" : "ws:";
  return { url: resource.toString(), expiresAt: response.expiresAt };
}

export function configureClankyClient(
  options: WebAppClientOptions & { remote?: WebAppRemoteClientOptions } = {},
): void {
  const { remote, ...core } = options;
  const mode = options.mode ?? (options.external ? "external" : remote ? "remote" : getWebAppClientMode());
  if (mode === "external") {
    if (getClientSession().enabled || remote) {
      throw new TypeError("An external client cannot also use remote server credentials.");
    }
    configureWebAppClient(core);
    const external = options.external;
    if (external) configureExternalClientStorageScope(() => `external:${validateExternalSession(external.session.getSnapshot()).scope}`);
    return;
  }
  if (mode === "remote") configureRemoteClient(core.apiBaseUrl ?? undefined, remote);
  configureWebAppClient({
    ...core,
    mode,
    runtime: clankyClientRuntime,
    request,
    ...(getClientSession().enabled ? {
      apiBaseUrl: getClientSession().endpoint,
      resourceUrl,
      connect: async (path: string, options: { signal?: AbortSignal }) => {
        const resource = await resourceUrl(path, { ...options, kind: "websocket" });
        options.signal?.throwIfAborted();
        return nativeWebAppDuplex(new WebSocket(resource.url), options.signal);
      },
    } : {}),
  });
}
