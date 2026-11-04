import type { Server } from "bun";
import {
  clientPreflight,
  createLogger,
  createWebAppServer,
  errorResponse,
  notFound,
  resetServerLogStorage,
  responseForRequest,
  serverForRewrittenRequest,
  serverLogStorage,
  setLogLevel,
  setServerLogStorageEnabled,
  withClientCors,
  withSecurityHeaders,
  type ServerLogStorage,
} from "@pablozaiden/webapp/server";
import { compareSpecificity, compileRoutePatterns, patternsOverlap } from "@pablozaiden/webapp/routing";
import type { AuthenticatedDispatchOptions } from "./authenticated-dispatch";
import { authErrorResponse, createAuthentication } from "./authentication";
import { CLIENT_TICKET_PARAMETER } from "./auth/client-tickets";
import { createOAuthService } from "./auth/oauth";
import { AuthError } from "./auth/types";
import { toCurrentUser } from "./auth/users";
import type { DelegatedDispatchOptions } from "./delegation";
import { createAccountEndpointHandler } from "./account-endpoints";
import { createRouteCatalog } from "./route-catalog";
import { createRouteDispatcher } from "./route-dispatch";
import { compileRouteTable } from "./routes";
import { readRuntimeConfig, resolveEffectiveLogLevel } from "./runtime-config";
import type { WebAppServer, WebAppServerConfig, WebAppWebSocketData } from "./server-types";

const log = createLogger("clanky:requests");

function restoreServerLogs(enabled: boolean, reset = false): void {
  try {
    if (reset) resetServerLogStorage();
    setServerLogStorageEnabled(enabled);
  } catch (error) {
    console.error("Unable to initialize temporary server log capture; continuing with capture disabled.", error);
    try {
      resetServerLogStorage();
    } catch (cleanupError) {
      console.error("Unable to reset temporary server log capture.", cleanupError);
    }
  }
}

export function createClankyPlatformServer<TEvent = unknown>(
  input: WebAppServerConfig<TEvent>,
): WebAppServer<TEvent> {
  if (input.requestFilter && input.web !== false) throw new Error("requestFilter requires web: false");
  const config = input.runtimeConfig ?? readRuntimeConfig(input);
  const store = input.store;
  const passkeysEnabled = input.auth?.passkeys !== false;
  const apiKeysEnabled = input.auth?.apiKeys ?? false;
  const deviceAuthEnabled = input.auth?.deviceAuth ?? false;
  const wsPath = input.realtime?.path ?? "/api/ws";
  const version = input.version ?? "0.0.0-development";
  restoreServerLogs(store.getServerLogsEnabledPreference() ?? false, true);
  const serverLogs: ServerLogStorage = {
    ...serverLogStorage,
    setEnabled(enabled) {
      serverLogStorage.setEnabled(enabled);
    },
  };
  const level = resolveEffectiveLogLevel(config, store.getLogLevelPreference());
  setLogLevel(level);
  input.logLevel?.onChange?.(level);
  const authentication = createAuthentication({
    config, store, passkeysEnabled, apiKeysEnabled, deviceAuthEnabled, realtimePath: wsPath,
  });
  if (input.auth?.oauth && !passkeysEnabled) throw new Error("OAuth consent requires browser authentication");
  const oauth = input.auth?.oauth ? createOAuthService(input.auth.oauth, store, config, authentication) : undefined;
  const endpoints = createAccountEndpointHandler({
    config, store, authentication, version, wsPath, passkeysEnabled, apiKeysEnabled, deviceAuthEnabled,
    webMode: input.web === false ? "disabled" : input.web?.mode === "auth" ? "auth" : "app",
    configResponse: input.configResponse,
    onLogLevelChange: input.logLevel?.onChange,
    serverLogs,
  });
  const applicationRoutes = compileRouteTable(input.routes ?? {});
  const accountRoutes = Object.fromEntries(compileRouteTable(endpoints.routes).routes.map(account => {
    let cliPath = account.cliPath;
    let cli = account.patterns.cli;
    while (applicationRoutes.routes.some(application => application.route.catalog !== false
      && patternsOverlap(application.patterns.cli, cli)
      && compareSpecificity(application.patterns.cli, cli) === 0)) {
      cliPath = `framework/${cliPath}`;
      cli = compileRoutePatterns(account.pattern, cliPath).cli;
    }
    return [account.pattern, { ...account.route, cliPath }];
  }));
  const routeTable = { ...input.routes, ...accountRoutes };
  const routes = compileRouteTable(routeTable);
  const routeCatalog = createRouteCatalog(routeTable);
  let dispatcher: ReturnType<typeof createRouteDispatcher<TEvent>>;

  async function allowed(request: Request): Promise<boolean> {
    return !input.requestFilter || await input.requestFilter(request);
  }

  async function requestHook(request: Request, server?: Server<WebAppWebSocketData>): Promise<Response | undefined> {
    let response: Response | undefined;
    try {
      if (!await allowed(request)) return withSecurityHeaders(notFound());
      response = clientPreflight(request);
      if (!response) {
        const prepared = await authentication.prepareRequest(request);
        let upgraded = false;
        const trackedServer = server && new Proxy(server, {
          get(target, property) {
            if (property === "upgrade") return (...args: Parameters<typeof server.upgrade>) => {
              const accepted = target.upgrade(...args);
              upgraded ||= accepted;
              return accepted;
            };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const preparedServer = serverForRewrittenRequest(trackedServer, request, prepared);
        response = await oauth?.handleRequest(prepared);
        if (!response) response = await endpoints.handleBuiltIn(prepared, preparedServer);
        if (upgraded) return undefined;
        if (!response) {
          const result = await dispatcher.dispatch(prepared, preparedServer);
          if (upgraded) return undefined;
          if (result.matched) response = result.response;
          else {
            const path = new URL(prepared.url).pathname;
            if (path.startsWith("/api/") || path.startsWith("/.well-known/")) response = notFound();
          }
        }
      }
    } catch (error) {
      if (error instanceof AuthError) response = authErrorResponse(error);
      else {
        log.error("Unhandled request error", { error: String(error) });
        response = errorResponse(500, "request_failed", "Request failed");
      }
    }
    if (!response) return undefined;
    if (new URL(request.url).searchParams.has(CLIENT_TICKET_PARAMETER)) {
      response.headers.set("cache-control", "private, no-store");
      response.headers.set("referrer-policy", "no-referrer");
    }
    return withClientCors(request, withSecurityHeaders(response));
  }

  const { mode, ...web } = input.web || {};
  const core = createWebAppServer<TEvent>({
    appName: input.appName,
    envPrefix: input.envPrefix,
    appDirectoryName: input.appDirectoryName,
    runtimeConfig: config,
    version,
    web: input.web === false ? false : {
      ...web,
      ...(mode === "auth" ? { paths: ["/", "/login", "/setup", "/device", "/account", ...(oauth ? [oauth.consentPath] : [])] } : {}),
    },
    server: input.server,
    publicRoutes: input.publicRoutes,
    websockets: input.websockets,
    realtime: input.realtime,
    request: requestHook,
    lifecycle: {
      ...input.lifecycle,
      beforeStart: async () => {
        restoreServerLogs(store.getServerLogsEnabledPreference() ?? false);
        await input.lifecycle?.beforeStart?.();
      },
      afterStop: async server => {
        authentication.clearClientTickets();
        try {
          await input.lifecycle?.afterStop?.(server);
        } finally {
          resetServerLogStorage();
        }
      },
    },
  });
  setLogLevel(level);
  dispatcher = createRouteDispatcher({ config, routes, authentication, realtime: core.realtime, middleware: input.routeMiddleware });

  async function dispatchDelegated<TAuthorization extends object>(
    request: Request,
    options: DelegatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined> {
    if (!await allowed(request)) return withSecurityHeaders(notFound());
    const result = await dispatcher.dispatch(request, undefined, options);
    return result.matched ? result.response : withSecurityHeaders(notFound());
  }

  async function dispatchAuthenticated<TAuthorization extends object>(
    request: Request,
    options: AuthenticatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined> {
    if (!await allowed(request)) return responseForRequest(request, withSecurityHeaders(notFound()));
    const user = store.getUserById(options.userId);
    if (!user || user.disabledAt) {
      return responseForRequest(request, withSecurityHeaders(errorResponse(403, "authentication_required", "An enabled account is required")));
    }
    const result = await dispatcher.dispatch(request, undefined, undefined, {
      ...options,
      actor: Object.freeze(toCurrentUser(user)),
      validateActor() {
        const current = store.getUserById(user.id);
        return Boolean(current && !current.disabledAt && current.authVersion === user.authVersion && current.role === user.role);
      },
    });
    return result.matched ? result.response : responseForRequest(request, withSecurityHeaders(notFound()));
  }

  return {
    ...core,
    config,
    store,
    oauth,
    routeCatalog,
    dispatchDelegated,
    dispatchAuthenticated,
    async stop(closeActiveConnections) {
      try {
        await core.stop(closeActiveConnections);
      } finally {
        authentication.clearClientTickets();
        resetServerLogStorage();
      }
    },
  };
}
