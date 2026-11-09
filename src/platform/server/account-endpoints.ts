import type { Server } from "bun";
import type { LogLevelName, WebAppConfigResponse } from "../contracts";
import { DEFAULT_THEME_PREFERENCE } from "../contracts";
import {
  authenticateApiKey,
  assertScopes,
} from "./auth/api-keys";
import {
  approveDevice,
  createDeviceAuthorization,
  denyDevice,
  discovery,
  exchangeDeviceCode,
  exchangeRefreshToken,
  getDeviceVerificationDetails,
  jwks,
  revokeRefreshToken,
} from "./auth/device-auth";
import {
  beginAuthentication,
  beginBootstrapRegistration,
  beginOwnerPasskeySetup,
  beginSetupRegistration,
  createBrowserSessionHeaders,
  completeAuthentication,
  completeBootstrapRegistration,
  completeOwnerPasskeySetup,
  completeSetupRegistration,
  deletePasskey,
  getSetupDetails,
  isPasskeyAuthRequired,
  logoutHeaders,
  passkeyStatus,
} from "./auth/passkeys";
import type { ClankyAccountStore } from "./auth/store";
import { changePassword, enrollPassword, loginWithPassword } from "./auth/passwords";
import { getRequestOriginInfo } from "@pablozaiden/webapp/server";
import type { Authentication } from "./authentication";
import { authErrorResponse, scopesFromBearer, tokenError } from "./authentication";
import { checkSameOrigin } from "./same-origin";
import type { WebAppServerConfig } from "./server-types";
import {
  authenticationResponseSchema,
  clientTicketRequestSchema,
  apiKeyAuthenticationRequestSchema,
  deviceAuthorizationRequestSchema,
  deviceCodeActionRequestSchema,
  serverLogSettingsRequestSchema,
  logLevelPreferenceRequestSchema,
  passkeyBootstrapOptionsSchema,
  passwordChangeRequestSchema,
  passwordEnrollmentRequestSchema,
  passwordLoginRequestSchema,
  refreshTokenRequestSchema,
  registrationResponseSchema,
  revokeRefreshTokenRequestSchema,
  setupOptionsSchema,
  setupVerificationSchema,
  themePreferenceRequestSchema,
  tokenRequestSchema,
} from "./request-schemas";
import { resolveEffectiveLogLevel, type RuntimeConfig } from "./runtime-config";
import { setLogLevel } from "@pablozaiden/webapp/server";
import type { ServerLogStorage } from "@pablozaiden/webapp/server";
import {
  errorResponse,
  jsonResponse,
  MAX_WEBAUTHN_JSON_BODY_BYTES,
  parseJson,
  successResponse,
} from "@pablozaiden/webapp/server";
import type { WebSocketData } from "@pablozaiden/webapp/server";
import { scheduleProcessShutdown } from "@pablozaiden/webapp/server";
import { defineRoutes, type RouteContext } from "./routes";
import { createAccountRoutes } from "./account-routes";

const MAX_API_KEY_AUTH_BODY_BYTES = 4 * 1024;
const MAX_PASSWORD_AUTH_BODY_BYTES = 16 * 1024;

export interface AccountEndpointDependencies {
  config: RuntimeConfig;
  store: ClankyAccountStore;
  authentication: Authentication;
  version: string;
  wsPath: string;
  passkeysEnabled: boolean;
  apiKeysEnabled: boolean;
  deviceAuthEnabled: boolean;
  webMode: "app" | "auth" | "disabled";
  configResponse?: WebAppServerConfig["configResponse"];
  onLogLevelChange?: (level: LogLevelName) => void;
  serverLogs: ServerLogStorage;
}

function addHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) {
    response.headers.append(name, value);
  }
  return response;
}

export function createAccountEndpointHandler(dependencies: AccountEndpointDependencies) {
  const {
    config,
    store,
    authentication,
    version,
    wsPath,
    passkeysEnabled,
    apiKeysEnabled,
    deviceAuthEnabled,
    webMode,
    configResponse: extendConfigResponse,
    onLogLevelChange,
    serverLogs,
  } = dependencies;

  async function authorize(
    req: Request,
    required: boolean,
    allowScopedDevice = false,
  ) {
    const auth = await authentication.authorize(req, required);
    if (auth instanceof Response) return auth;
    if (auth.kind === "api-key") assertScopes(auth.scopes, []);
    if (auth.kind === "bearer" && !allowScopedDevice) assertScopes(scopesFromBearer(auth.claims), []);
    return auth;
  }

  async function configResponse(req: Request, context: RouteContext): Promise<Response> {
    const auth = context.auth;
    if (auth.kind === "api-key") assertScopes(auth.scopes, []);
    const user = authentication.currentUser(auth) ?? authentication.configUser(req);
    const passkeyAuth = passkeyStatus(req, store, config, passkeysEnabled, user?.id);
    if (auth.kind === "bearer" || auth.kind === "api-key" || auth.kind === "server") {
      passkeyAuth.authenticated = true;
      passkeyAuth.passkeyRequired = false;
      passkeyAuth.bootstrapRequired = false;
      passkeyAuth.ownerPasskeySetupRequired = false;
    }
    const base = {
      appName: config.appName,
      version,
      publicBasePath: getRequestOriginInfo(req, config).pathPrefix,
      realtime: { path: wsPath },
      web: { mode: webMode },
      currentUser: user,
      passkeyAuth,
      userManagement: {
        enabled: passkeysEnabled,
        canManageUsers: Boolean(user?.isAdmin),
      },
      logLevel: {
        level: resolveEffectiveLogLevel(config, store.getLogLevelPreference()),
        fromEnv: config.logLevelFromEnv,
      },
      inMemoryLogs: {
        enabled: serverLogs.isEnabled(),
      },
      apiKeys: { enabled: Boolean(apiKeysEnabled) },
      deviceAuth: { enabled: Boolean(deviceAuthEnabled) },
    } satisfies WebAppConfigResponse;
    return jsonResponse({ ...(extendConfigResponse?.(req, base) ?? {}), ...base });
  }

  const healthResponse = () => successResponse({ ok: true, version });
  const routes = defineRoutes({
    ...createAccountRoutes({ store, config, passkeysEnabled, apiKeysEnabled, deviceAuthEnabled }),
    "/api/health": {
      auth: "public", sameOrigin: "never", tags: ["diagnostics"],
      description: "Read server health and the running application version.",
      operations: { GET: { automation: { policy: "read" } } },
      GET: healthResponse,
    },
    "/api/config": {
      auth: "public", sameOrigin: "never", tags: ["configuration"],
      description: "Read public application configuration and the current authenticated user.",
      operations: { GET: { automation: { policy: "read" } } },
      GET: configResponse,
    },
    "/api/preferences/theme": {
      auth: "user", sameOrigin: "mutations", tags: ["preferences"],
      description: "Read or update the current user's theme preference.",
      operations: {
        GET: { automation: { policy: "read" } },
        PUT: { requestSchema: themePreferenceRequestSchema, automation: { policy: "write" } },
      },
      GET: (_req, context) => jsonResponse({
        theme: store.getThemePreference(context.requireUser().id) ?? DEFAULT_THEME_PREFERENCE,
      }),
      async PUT(req, context) {
        const body = await parseJson(req, themePreferenceRequestSchema);
        store.setThemePreference(body.theme, context.requireUser().id);
        return successResponse({ theme: body.theme });
      },
    },
    "/api/preferences/log-level": {
      auth: "admin", sameOrigin: "mutations", tags: ["preferences", "diagnostics"],
      description: "Read or update the server log level unless controlled by environment.",
      operations: {
        GET: { automation: { policy: "read" } },
        PUT: { requestSchema: logLevelPreferenceRequestSchema, automation: { policy: "write" } },
      },
      GET: () => jsonResponse({
        level: resolveEffectiveLogLevel(config, store.getLogLevelPreference()),
        fromEnv: config.logLevelFromEnv,
      }),
      async PUT(req) {
        if (config.logLevelFromEnv) return errorResponse(409, "log_level_from_env", "Log level is controlled by environment");
        const body = await parseJson(req, logLevelPreferenceRequestSchema);
        store.setLogLevelPreference(body.level);
        setLogLevel(body.level);
        onLogLevelChange?.(body.level);
        return successResponse({ level: body.level });
      },
    },
    "/api/server/logs": {
      auth: "admin", sameOrigin: "mutations", tags: ["diagnostics"],
      description: "Read captured server logs when in-memory capture is enabled.",
      operations: { GET: { automation: { policy: "read" } } },
      GET() {
        const enabled = serverLogs.isEnabled();
        return jsonResponse({ enabled, logs: enabled ? serverLogs.getEntries() : [] });
      },
    },
    "/api/server/logs/settings": {
      auth: "admin", sameOrigin: "mutations", tags: ["diagnostics"],
      description: "Enable or disable in-memory server log capture.",
      operations: {
        PUT: { requestSchema: serverLogSettingsRequestSchema, automation: { policy: "write" } },
      },
      async PUT(req) {
        const body = await parseJson(req, serverLogSettingsRequestSchema);
        const previousEnabled = store.getServerLogsEnabledPreference() ?? false;
        store.setServerLogsEnabledPreference(body.enabled);
        try {
          serverLogs.setEnabled(body.enabled);
        } catch (error) {
          const errors: unknown[] = [error];
          try {
            serverLogs.setEnabled(previousEnabled);
          } catch (restoreError) {
            errors.push(restoreError);
          }
          try {
            store.setServerLogsEnabledPreference(previousEnabled);
          } catch (restoreError) {
            errors.push(restoreError);
          }
          if (errors.length > 1) throw new AggregateError(errors, "Unable to update server-log capture setting");
          throw error;
        }
        return successResponse({ enabled: serverLogs.isEnabled() });
      },
    },
    "/api/server/kill": {
      auth: "admin", sameOrigin: "mutations", tags: ["maintenance"],
      description: "Shut down the server process, interrupting its active connections.",
      operations: {
        POST: { automation: { policy: "confirm", reason: "Shuts down the application server and interrupts active work.", completion: "admission" } },
      },
      POST() {
        scheduleProcessShutdown();
        return successResponse({ success: true, message: "Server is shutting down" });
      },
    },
  });

  async function handleBuiltIn(req: Request, server?: Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/health" && req.method === "GET") {
        return healthResponse();
      }
      if (deviceAuthEnabled && path === "/api/auth/client-ticket" && req.method === "POST") {
        const auth = await authorize(req, true, true);
        if (auth instanceof Response) return auth;
        const body = await parseJson(req, clientTicketRequestSchema);
        return jsonResponse(authentication.issueClientTicket(req, auth, body), {
          headers: { "cache-control": "no-store" },
        });
      }
      if (path === wsPath) {
        const auth = await authorize(req, true, true);
        if (auth instanceof Response) return auth;
        const user = authentication.requireUser(auth);
        const originFailure = checkSameOrigin(req, config, auth, "always");
        if (originFailure) return originFailure;
        if (!server) return errorResponse(400, "websocket_unavailable", "WebSocket server is unavailable");
        if (url.search) return errorResponse(400, "invalid_subscription", "Use realtime subscription messages, not URL query filters");
        const upgraded = server.upgrade(req, { data: { userId: user.id } });
        return upgraded ? undefined : errorResponse(400, "websocket_upgrade_failed", "WebSocket upgrade failed");
      }
      if (path === "/api/auth/status" && req.method === "GET") {
        const auth = await authorize(req, true, true);
        if (auth instanceof Response) return auth;
        const user = authentication.currentUser(auth);
        return jsonResponse({
          authenticated: auth.kind !== "anonymous",
          authKind: auth.kind,
          subject: user?.id ?? null,
          clientId: auth.kind === "bearer" ? auth.claims.clientId : null,
          scope: auth.kind === "bearer" ? auth.claims.scope : null,
        });
      }
      if (path === "/api/passkey-auth/status" && req.method === "GET") {
        return jsonResponse(passkeyStatus(req, store, config, passkeysEnabled));
      }
      // Public login only authenticates existing accounts; owner enrollment remains local.
      if (passkeysEnabled && !config.passkeyDisabled && path === "/api/auth/password/login" && req.method === "POST") {
        const body = await parseJson(req, passwordLoginRequestSchema, { maxBytes: MAX_PASSWORD_AUTH_BODY_BYTES });
        const user = await loginWithPassword(req, store, getRequestOriginInfo(req, config).origin, body.username, body.password);
        return addHeaders(successResponse(undefined, { headers: { "cache-control": "no-store" } }), createBrowserSessionHeaders(req, store, config, user));
      }
      if (passkeysEnabled && !config.passkeyDisabled && path === "/api/auth/password") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const user = authentication.requireUser(auth);
        if (req.method === "GET") {
          return jsonResponse({ configured: Boolean(store.getPassword(user.id)) }, { headers: { "cache-control": "no-store" } });
        }
        if (req.method === "POST" || req.method === "PUT") {
          const originFailure = checkSameOrigin(req, config, auth, "mutations");
          if (originFailure) return originFailure;
          const origin = getRequestOriginInfo(req, config).origin;
          const authorizedUser = store.getUserById(user.id);
          if (!authorizedUser || authorizedUser.disabledAt) return errorResponse(401, "authentication_required", "Authentication is required");
          let updated;
          if (req.method === "POST") {
            const body = await parseJson(req, passwordEnrollmentRequestSchema, { maxBytes: MAX_PASSWORD_AUTH_BODY_BYTES });
            updated = await enrollPassword(req, store, origin, user.id, body.password, authorizedUser.authVersion);
          } else {
            const body = await parseJson(req, passwordChangeRequestSchema, { maxBytes: MAX_PASSWORD_AUTH_BODY_BYTES });
            updated = await changePassword(req, store, origin, user.id, body.currentPassword, body.nextPassword, authorizedUser.authVersion);
          }
          return addHeaders(jsonResponse({ configured: true }, { headers: { "cache-control": "no-store" } }), createBrowserSessionHeaders(req, store, config, updated));
        }
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/options" && req.method === "POST") {
        const body = await parseJson(req, passkeyBootstrapOptionsSchema);
        const result = await beginBootstrapRegistration(req, store, config, body.username ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/bootstrap/verify" && req.method === "POST") {
        const headers = await completeBootstrapRegistration(
          req,
          store,
          config,
          await parseJson(req, registrationResponseSchema, { maxBytes: MAX_WEBAUTHN_JSON_BODY_BYTES }),
        );
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/options" && req.method === "POST") {
        const auth = await authorize(req, false);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const result = await beginOwnerPasskeySetup(req, store, config, authentication.currentUser(auth)?.id);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/owner-setup/verify" && req.method === "POST") {
        const auth = await authorize(req, false);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const headers = await completeOwnerPasskeySetup(
          req,
          store,
          config,
          await parseJson(req, registrationResponseSchema, { maxBytes: MAX_WEBAUTHN_JSON_BODY_BYTES }),
          authentication.currentUser(auth)?.id,
        );
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/user-setup" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        return jsonResponse(getSetupDetails(store, token));
      }
      if (passkeysEnabled && path === "/api/user-setup/options" && req.method === "POST") {
        const body = await parseJson(req, setupOptionsSchema);
        const result = await beginSetupRegistration(req, store, config, body.token ?? "");
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/user-setup/verify" && req.method === "POST") {
        const body = await parseJson(req, setupVerificationSchema, { maxBytes: MAX_WEBAUTHN_JSON_BODY_BYTES });
        const headers = await completeSetupRegistration(req, store, config, body.token, body.response);
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/options" && req.method === "POST") {
        const result = await beginAuthentication(req, store, config);
        return addHeaders(jsonResponse(result.options), result.headers);
      }
      if (passkeysEnabled && path === "/api/passkey-auth/authentication/verify" && req.method === "POST") {
        const headers = await completeAuthentication(
          req,
          store,
          config,
          await parseJson(req, authenticationResponseSchema, { maxBytes: MAX_WEBAUTHN_JSON_BODY_BYTES }),
        );
        return addHeaders(successResponse(), headers);
      }
      if (passkeysEnabled && apiKeysEnabled && path === "/api/passkey-auth/api-key" && req.method === "POST") {
        const originFailure = checkSameOrigin(req, config, { kind: "anonymous" }, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, apiKeyAuthenticationRequestSchema, { maxBytes: MAX_API_KEY_AUTH_BODY_BYTES });
        const apiKey = authenticateApiKey(store, body.apiKey);
        if (!apiKey || !apiKey.scopes.includes("*")) {
          return errorResponse(401, "invalid_api_key", "Invalid API key");
        }
        const user = store.getUserById(apiKey.user.id);
        if (!user) {
          return errorResponse(401, "invalid_api_key", "Invalid API key");
        }
        return addHeaders(successResponse(), createBrowserSessionHeaders(req, store, config, user));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/logout" && req.method === "POST") {
        return addHeaders(successResponse(), logoutHeaders(req, config));
      }
      if (passkeysEnabled && path === "/api/passkey-auth/passkey" && req.method === "DELETE") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        return addHeaders(successResponse(), deletePasskey(req, store, config, authentication.requireUser(auth).id));
      }
      if (deviceAuthEnabled && path === "/api/auth/device" && req.method === "POST") {
        const body = await parseJson(req, deviceAuthorizationRequestSchema);
        return jsonResponse(createDeviceAuthorization(req, store, config, body));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/verification" && req.method === "GET") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const userCode = url.searchParams.get("user_code")?.trim();
        if (!userCode) return errorResponse(400, "invalid_user_code", "user_code is required");
        return jsonResponse(getDeviceVerificationDetails(store, userCode, passkeysEnabled && isPasskeyAuthRequired(store, config)));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/approve" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, deviceCodeActionRequestSchema);
        return jsonResponse(approveDevice(store, body.userCode, authentication.requireUser(auth).id));
      }
      if (deviceAuthEnabled && path === "/api/auth/device/deny" && req.method === "POST") {
        const auth = await authorize(req, true);
        if (auth instanceof Response) return auth;
        const originFailure = checkSameOrigin(req, config, auth, "mutations");
        if (originFailure) return originFailure;
        const body = await parseJson(req, deviceCodeActionRequestSchema);
        return jsonResponse(denyDevice(store, body.userCode));
      }
      if (deviceAuthEnabled && path === "/api/auth/refresh" && req.method === "POST") {
        const body = await parseJson(req, refreshTokenRequestSchema);
        try {
          return jsonResponse(await exchangeRefreshToken(store, config, body.refresh_token, body.client_id));
        } catch (error) {
          return tokenError(error);
        }
      }
      if (deviceAuthEnabled && path === "/api/auth/token" && req.method === "POST") {
        const body = await parseJson(req, tokenRequestSchema);
        try {
          if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code" || body.device_code) {
            return jsonResponse(await exchangeDeviceCode(store, config, body.device_code ?? "", body.client_id));
          }
          return jsonResponse(await exchangeRefreshToken(store, config, body.refresh_token ?? "", body.client_id));
        } catch (error) {
          return tokenError(error);
        }
      }
      if (deviceAuthEnabled && path === "/api/auth/revoke" && req.method === "POST") {
        const body = await parseJson(req, revokeRefreshTokenRequestSchema);
        revokeRefreshToken(store, body.refreshToken);
        return successResponse();
      }
      if (deviceAuthEnabled && path === "/.well-known/jwks.json" && req.method === "GET") {
        return jsonResponse(await jwks(store));
      }
      if (deviceAuthEnabled && path === "/.well-known/openid-configuration" && req.method === "GET") {
        return jsonResponse(discovery(req, config));
      }
    } catch (error) {
      return authErrorResponse(error);
    }
    return undefined;
  }

  return { handleBuiltIn, routes };
}
