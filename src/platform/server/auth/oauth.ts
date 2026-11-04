import { z } from "zod";
import type { CurrentUser } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import { jsonResponse, methodNotAllowed, parseJson, requestBodyErrorResponse } from "@pablozaiden/webapp/server";
import { randomToken, secureEqual, sha256 } from "./crypto";
import { getPasskeySessionUser } from "./passkeys";
import { getRequestOriginInfo } from "@pablozaiden/webapp/server";
import type { Authentication } from "../authentication";
import { scopesFromBearer } from "../authentication";
import { checkSameOrigin } from "../same-origin";
import { assertScopes } from "./api-keys";
import type { UserRecord, ClankyAccountStore } from "./store";
import { AuthError } from "./types";
import { toCurrentUser } from "./users";
import {
  authenticateOAuthClient, describeOAuthScopes, oauthClient, oauthError, oauthForm, oauthScopes,
  requireOAuthResource, uniqueOAuthParameters, validateOAuthConfig,
  type ValidatedOAuthClient,
} from "./oauth-validation";
import type {
  OAuthAuthorizationRecord, OAuthConfig, OAuthPrincipal, OAuthService, OAuthSessionRecord,
} from "./oauth-types";

const ACCESS_SECONDS = 600;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_SECONDS = 600;
const CODE_SECONDS = 60;
const consentSchema = z.object({
  request: z.string().min(1).max(128),
  decision: z.enum(["approve", "deny"]),
  approval: z.record(z.string(), z.json()).default({}),
}).strict();
const approvalSchema = z.object({
  scopes: z.array(z.string()).min(1).optional(),
  authorizationContext: z.record(z.string(), z.json()).default({}),
}).strict();

export function createOAuthClientSecret(): { secret: string; secretHash: string } {
  const secret = `oauth_secret_${randomToken()}`;
  return { secret, secretHash: sha256(secret) };
}

function protocolResponse(data: unknown, status = 200): Response {
  return jsonResponse(data, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export function createOAuthService(input: OAuthConfig, accounts: ClankyAccountStore, runtime: RuntimeConfig, authentication: Authentication): OAuthService & {
  handleRequest(request: Request): Promise<Response | undefined>;
  routePaths: readonly string[];
  consentPath: string;
} {
  const config = validateOAuthConfig(input);
  const store = accounts.oauth;
  if (!store) throw new Error("OAuth requires a ClankyAccountStore with atomic OAuth persistence");
  store.initialize();

  function account(userId: string | undefined, authVersion: number | undefined, expectedRole?: UserRecord["role"]): UserRecord {
    const user = userId ? accounts.getUserById(userId) : undefined;
    if (!user || user.disabledAt || user.authVersion !== authVersion
      || (expectedRole !== undefined && user.role !== expectedRole)) {
      oauthError("invalid_grant", "Authorization is no longer valid");
    }
    return user;
  }

  function principal(session: OAuthSessionRecord, expectedRole?: UserRecord["role"]): OAuthPrincipal {
    return Object.freeze({
      user: Object.freeze(toCurrentUser(account(session.userId, session.authVersion, expectedRole))),
      clientId: session.clientId, resource: session.resource,
      scopes: Object.freeze([...session.scopes]),
      authorizationContext: structuredClone(session.authorizationContext), grantId: session.familyId,
    });
  }

  function validSession(session: OAuthSessionRecord | undefined, now: number): session is OAuthSessionRecord {
    return Boolean(session && session.revokedAt === undefined && session.expiresAt > now
      && session.resource === config.resource && session.issuer === config.issuer
      && config.clients.some(client => client.clientId === session.clientId));
  }

  async function admitted(subject: OAuthPrincipal): Promise<boolean> {
    return !config.validateAuthorization || await config.validateAuthorization(subject) === true;
  }

  function challenge(error: "invalid_token" | "insufficient_scope" | undefined, scopes: readonly string[], status: number): Response {
    const value = [
      `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"`,
      scopes.length ? `scope="${scopes.join(" ")}"` : "",
      error ? `error="${error}"` : "",
    ].filter(Boolean).join(", ");
    const response = protocolResponse({ error: error ?? "unauthorized" }, status);
    response.headers.set("www-authenticate", value);
    return response;
  }

  async function authenticate(request: Request, requiredScopes: readonly string[] = config.resourceScopes): Promise<OAuthPrincipal | Response> {
    try {
      // Validate application-provided challenge values before placing them in a header.
      if (requiredScopes.length) oauthScopes(requiredScopes.join(" "));
      if (new URL(request.url).searchParams.has("access_token")) {
        return protocolResponse({ error: "invalid_request", error_description: "Use the Authorization header" }, 400);
      }
      const header = request.headers.get("authorization");
      if (!header) return challenge(undefined, requiredScopes, 401);
      const token = /^Bearer (oauth_access_[A-Za-z0-9_-]{43})$/i.exec(header)?.[1];
      if (!token) return challenge("invalid_token", requiredScopes, 401);
      const session = store!.getSessionByTokenHash(sha256(token));
      const now = Date.now();
      if (!validSession(session, now) || session.accessExpiresAt <= now
        || !secureEqual(session.accessHash, sha256(token))) {
        return challenge("invalid_token", requiredScopes, 401);
      }
      const observed = principal(session);
      if (!await admitted(observed)) return challenge("invalid_token", requiredScopes, 401);
      // Re-read after the asynchronous application check: rotation/revocation may have won.
      const current = store!.getSessionByTokenHash(sha256(token));
      if (!validSession(current, Date.now()) || current.accessExpiresAt <= Date.now()) {
        return challenge("invalid_token", requiredScopes, 401);
      }
      const result = principal(current, observed.user.role);
      if (requiredScopes.some(scope => !result.scopes.includes(scope))) {
        return challenge("insufficient_scope", requiredScopes, 403);
      }
      return result;
    } catch (error) {
      if (error instanceof AuthError) return challenge("invalid_token", requiredScopes, 401);
      return protocolResponse({ error: "server_error" }, 500);
    }
  }

  function browserUser(request: Request, mutation = false, expectedUserId?: string): CurrentUser {
    // Neither API/device/OAuth bearers nor the emergency passkey bypass can consent.
    if (runtime.passkeyDisabled || request.headers.has("authorization")) {
      oauthError("access_denied", "An authenticated browser session is required", 403);
    }
    const user = getPasskeySessionUser(request, accounts, runtime);
    if (!user) oauthError("login_required", "Sign in before reviewing this authorization", 401);
    if (expectedUserId !== undefined && user.id !== expectedUserId) {
      oauthError("access_denied", "The browser session no longer matches this authorization", 403);
    }
    if (mutation && request.headers.get("origin") !== config.issuerUrl.origin) {
      oauthError("access_denied", "Same-origin consent is required", 403);
    }
    return user;
  }

  function authorization(handle: string): OAuthAuthorizationRecord {
    if (!/^oauth_request_[A-Za-z0-9_-]{43}$/.test(handle)) oauthError("invalid_request", "Invalid authorization request");
    const record = store!.getAuthorization(sha256(handle));
    if (!record || record.expiresAt <= Date.now()
      || record.issuer !== config.issuer || record.resource !== config.resource) {
      oauthError("invalid_request", "Authorization request is invalid or expired");
    }
    if (!oauthClient(config, record.clientId).redirectUris.includes(record.redirectUri)) {
      oauthError("invalid_request", "The redirect URI is no longer registered");
    }
    return record;
  }

  function callback(record: Pick<OAuthAuthorizationRecord, "redirectUri" | "state">, response: Record<string, string>): string {
    const redirect = new URL(record.redirectUri);
    for (const [key, value] of Object.entries(response)) redirect.searchParams.set(key, value);
    if (record.state !== undefined) redirect.searchParams.set("state", record.state);
    redirect.searchParams.set("iss", config.issuer);
    return redirect.href;
  }

  async function begin(request: Request): Promise<Response> {
    if (request.url.length > 16 * 1024) oauthError("invalid_request", "Authorization request is too large");
    const parameters = uniqueOAuthParameters(new URL(request.url).searchParams);
    const client = oauthClient(config, parameters.get("client_id"));
    const redirectUri = parameters.get("redirect_uri");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      oauthError("invalid_request", "The redirect URI is not registered");
    }
    try {
      if (parameters.get("response_type") !== "code") oauthError("unsupported_response_type", "Only authorization code flow is supported");
      requireOAuthResource(config, parameters.get("resource"));
      const codeChallenge = parameters.get("code_challenge");
      if (parameters.get("code_challenge_method") !== "S256" || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
        oauthError("invalid_request", "PKCE S256 is required");
      }
      const state = parameters.get("state") ?? undefined;
      if (state !== undefined && state.length > 2048) oauthError("invalid_request", "State is too large");
      const scopes = oauthScopes(parameters.get("scope"));
      const scopeDescriptions = await describeOAuthScopes(config, scopes);
      const handle = `oauth_request_${randomToken()}`;
      store!.transaction(() => {
        store!.deleteExpired(Date.now());
        store!.saveAuthorization({
          issuer: config.issuer, resource: config.resource, clientId: client.clientId,
          requestHash: sha256(handle), redirectUri, scopes, scopeDescriptions, codeChallenge, state,
          expiresAt: Date.now() + AUTHORIZATION_SECONDS * 1000, status: "pending",
        });
      });
      const consent = new URL(config.consentUrl);
      consent.searchParams.set("request", handle);
      return redirectResponse(consent.href);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      const state = parameters.get("state");
      return redirectResponse(callback({ redirectUri, state: state !== null && state.length <= 2048 ? state : undefined }, {
        error: error.code, error_description: error.message,
      }));
    }
  }

  async function consentDetails(request: Request): Promise<Response> {
    const user = browserUser(request);
    const observedRole = user.role;
    const parameters = uniqueOAuthParameters(new URL(request.url).searchParams);
    const handle = parameters.get("request") ?? "";
    const record = store!.transaction(() => {
      const record = authorization(handle);
      if (record.status !== "pending" || (record.userId && record.userId !== user.id)) {
        oauthError("access_denied", "Authorization request is not available", 403);
      }
      const current = accounts.getUserById(user.id);
      if (!current || current.disabledAt || current.role !== observedRole) oauthError("access_denied", "Account is not available", 403);
      if (record.userId && record.authVersion !== current.authVersion) oauthError("access_denied", "Authorization is no longer valid", 403);
      const bound = { ...record, userId: user.id, authVersion: current.authVersion };
      store!.saveAuthorization(bound);
      return bound;
    });
    const client = oauthClient(config, record.clientId);
    const context = config.getConsentContext
      ? z.record(z.string(), z.json()).parse(await config.getConsentContext({
        user, client, resource: record.resource, scopes: Object.freeze([...record.scopes]),
      }))
      : undefined;
    if (context && Buffer.byteLength(JSON.stringify(context), "utf8") > 8192) {
      throw new Error("OAuth consent presentation context is too large");
    }
    return store!.transaction(() => {
      const current = authorization(handle);
      if (current.status !== "pending" || current.userId !== user.id || current.authVersion !== record.authVersion) {
        oauthError("access_denied", "Authorization request is not available", 403);
      }
      account(current.userId, current.authVersion, observedRole);
      browserUser(request, false, current.userId);
      return protocolResponse({
        request: handle, client: { clientId: client.clientId, clientName: client.clientName },
        resource: record.resource,
        scopes: record.scopes.map(scope => ({ scope, description: record.scopeDescriptions[scope] })),
        expiresAt: new Date(record.expiresAt).toISOString(),
        ...(context === undefined ? {} : { consentContext: context }),
      });
    });
  }

  async function consentDecision(request: Request): Promise<Response> {
    const user = browserUser(request, true);
    const observedRole = user.role;
    const body = await parseJson(request, consentSchema, { requireContentType: true, maxBytes: 16 * 1024 });
    const record = authorization(body.request);
    if (record.status !== "pending" || record.userId !== user.id) oauthError("access_denied", "Review authorization before deciding", 403);
    account(record.userId, record.authVersion, observedRole);
    browserUser(request, true, record.userId);
    const client = oauthClient(config, record.clientId);
    const decision = body.decision === "approve"
      ? await config.authorizeConsent({
        user, client, resource: record.resource, scopes: Object.freeze([...record.scopes]), approval: body.approval,
      })
      : false;
    const approval = decision === false ? undefined : approvalSchema.parse(decision);
    const scopes = approval?.scopes ?? record.scopes;
    if (scopes.some(scope => !record.scopes.includes(scope)) || new Set(scopes).size !== scopes.length) {
      throw new Error("Application consent cannot widen requested OAuth scopes");
    }
    // Context is persisted, not returned to OAuth clients; keep it small and JSON-only.
    if (Buffer.byteLength(JSON.stringify(approval?.authorizationContext ?? {}), "utf8") > 8192) {
      throw new Error("OAuth authorization context is too large");
    }
    return store!.transaction(() => {
      const current = authorization(body.request);
      if (current.status !== "pending" || current.userId !== user.id || current.authVersion !== record.authVersion) {
        oauthError("access_denied", "Authorization request has already been decided", 403);
      }
      account(current.userId, current.authVersion, observedRole);
      browserUser(request, true, current.userId);
      if (!approval) {
        store!.saveAuthorization({ ...current, status: "denied" });
        return protocolResponse({ redirectUri: callback(current, { error: "access_denied" }) });
      }
      const code = `oauth_code_${randomToken()}`;
      store!.saveAuthorization({
        ...current, status: "approved", scopes,
        authorizationContext: approval.authorizationContext,
        codeHash: sha256(code), codeExpiresAt: Math.min(current.expiresAt, Date.now() + CODE_SECONDS * 1000),
      });
      return protocolResponse({ redirectUri: callback(current, { code }) });
    });
  }

  function issue(
    source: Pick<OAuthSessionRecord, "userId" | "authVersion" | "clientId" | "scopes" | "authorizationContext">,
    client: ValidatedOAuthClient,
    familyId: string,
    expiresAt: number,
  ): Response {
    const now = Date.now();
    const access = `oauth_access_${randomToken()}`;
    const refresh = client.grantTypes.includes("refresh_token") ? `oauth_refresh_${randomToken()}` : undefined;
    const session: OAuthSessionRecord = {
      ...source, issuer: config.issuer, resource: config.resource,
      id: crypto.randomUUID(), familyId, accessHash: sha256(access), refreshHash: refresh ? sha256(refresh) : undefined,
      accessExpiresAt: Math.min(expiresAt, now + ACCESS_SECONDS * 1000),
      expiresAt: refresh ? expiresAt : Math.min(expiresAt, now + ACCESS_SECONDS * 1000), createdAt: now,
    };
    store!.saveSession(session);
    return protocolResponse({
      access_token: access, token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((session.accessExpiresAt - now) / 1000)),
      scope: source.scopes.join(" "), ...(refresh ? { refresh_token: refresh } : {}),
    });
  }

  async function token(request: Request): Promise<Response> {
    const parameters = await oauthForm(request);
    const client = authenticateOAuthClient(config, request, parameters);
    requireOAuthResource(config, parameters.get("resource"));
    if (parameters.get("grant_type") === "authorization_code") {
      const code = parameters.get("code");
      const verifier = parameters.get("code_verifier");
      if (!code || !/^oauth_code_[A-Za-z0-9_-]{43}$/.test(code)
        || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) oauthError("invalid_grant", "Invalid authorization code or PKCE verifier");
      return store!.transaction(() => {
        const record = store!.getAuthorizationByCode(sha256(code));
        if (!record || !["approved", "consumed"].includes(record.status)
          || record.clientId !== client.clientId || record.redirectUri !== parameters.get("redirect_uri")
          || !client.redirectUris.includes(record.redirectUri)
          || record.issuer !== config.issuer || record.resource !== config.resource
          || !secureEqual(record.codeChallenge, sha256(verifier))) {
          oauthError("invalid_grant", "Invalid authorization code or PKCE verifier");
        }
        account(record.userId, record.authVersion);
        if (record.status === "consumed") {
          if (record.familyId) store!.revokeFamily(record.familyId, Date.now());
          return protocolResponse({ error: "invalid_grant", error_description: "Authorization code has already been used" }, 400);
        }
        if (record.expiresAt <= Date.now() || !record.codeExpiresAt || record.codeExpiresAt <= Date.now()) {
          oauthError("invalid_grant", "Invalid authorization code or PKCE verifier");
        }
        const familyId = crypto.randomUUID();
        const expiresAt = Date.now() + (client.grantTypes.includes("refresh_token") ? REFRESH_SECONDS : ACCESS_SECONDS) * 1000;
        store!.saveAuthorization({ ...record, status: "consumed", familyId, expiresAt });
        return issue({
          userId: record.userId!, authVersion: record.authVersion!, clientId: client.clientId,
          scopes: record.scopes, authorizationContext: record.authorizationContext ?? {},
        }, client, familyId, expiresAt);
      });
    }
    if (parameters.get("grant_type") !== "refresh_token" || !client.grantTypes.includes("refresh_token")) {
      oauthError("unsupported_grant_type", "Unsupported grant type");
    }
    const refresh = parameters.get("refresh_token");
    if (!refresh || !/^oauth_refresh_[A-Za-z0-9_-]{43}$/.test(refresh)) oauthError("invalid_grant", "Invalid refresh token");
    const snapshot = store!.getSessionByTokenHash(sha256(refresh));
    if (!snapshot || snapshot.clientId !== client.clientId || snapshot.issuer !== config.issuer || snapshot.resource !== config.resource) {
      oauthError("invalid_grant", "Invalid refresh token");
    }
    const observed = principal(snapshot);
    // Application policy denial/failure must not mask binding-verified replay.
    const policy = snapshot.revokedAt !== undefined ? { allowed: false } : await admitted(observed).then(
      allowed => ({ allowed }),
      (error: unknown) => ({ error }),
    );
    return store!.transaction(() => {
      const current = store!.getSessionByTokenHash(sha256(refresh));
      if (!current || current.clientId !== client.clientId || current.expiresAt <= Date.now()) {
        oauthError("invalid_grant", "Invalid refresh token");
      }
      if (current.revokedAt !== undefined) {
        store!.revokeFamily(current.familyId, Date.now());
        // Commit replay revocation rather than throwing and rolling it back.
        return protocolResponse({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
      }
      if ("error" in policy) throw policy.error;
      if (!policy.allowed) oauthError("invalid_grant", "Authorization is no longer valid");
      account(current.userId, current.authVersion, observed.user.role);
      const scopes = parameters.has("scope") ? oauthScopes(parameters.get("scope")) : current.scopes;
      if (scopes.some(scope => !current.scopes.includes(scope))) oauthError("invalid_scope", "Refresh cannot widen authorization");
      store!.saveSession({ ...current, revokedAt: Date.now() });
      return issue({ ...current, scopes }, client, current.familyId, current.expiresAt);
    });
  }

  async function revoke(request: Request): Promise<Response> {
    const parameters = await oauthForm(request);
    const client = authenticateOAuthClient(config, request, parameters);
    const value = parameters.get("token");
    if (!value) oauthError("invalid_request", "A token is required");
    return store!.transaction(() => {
      const session = store!.getSessionByTokenHash(sha256(value));
      if (session?.clientId === client.clientId && session.issuer === config.issuer && session.resource === config.resource) {
        store!.revokeFamily(session.familyId, Date.now());
      }
      return protocolResponse({});
    });
  }

  async function grants(request: Request): Promise<Response> {
    const auth = await authentication.authorize(request, true);
    if (auth instanceof Response) return auth;
    if (auth.kind === "api-key") assertScopes(auth.scopes, []);
    if (auth.kind === "bearer") assertScopes(scopesFromBearer(auth.claims), []);
    const user = authentication.requireUser(auth);
    const originError = checkSameOrigin(request, runtime, auth);
    if (originError) return originError;
    return store!.transaction(() => {
      const sessions = store!.listSessions(user.id).filter(session => validSession(session, Date.now()));
      if (request.method === "DELETE") {
        const id = uniqueOAuthParameters(new URL(request.url).searchParams).get("id");
        const found = sessions.find(session => session.familyId === id);
        if (found) store!.revokeFamily(found.familyId, Date.now());
        return protocolResponse({});
      }
      return protocolResponse({
        grants: sessions.filter(session => {
          const current = accounts.getUserById(user.id);
          return current?.authVersion === session.authVersion;
        }).map(session => ({
          id: session.familyId, clientId: session.clientId,
          clientName: oauthClient(config, session.clientId).clientName,
          resource: session.resource, scopes: session.scopes,
          authorizationContext: session.authorizationContext,
          createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString(),
        })),
      });
    });
  }

  async function handleRequest(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const resourceMetadata = path === config.metadataPath || path === "/.well-known/oauth-protected-resource";
    const asMetadata = path === config.issuerMetadataPath;
    const endpoint = path.startsWith(`${config.prefix}/`) ? path.slice(config.prefix.length) : undefined;
    const resourceRequest = path === config.resourcePath && config.handleResource !== undefined;
    if (!resourceMetadata && !asMetadata && !endpoint && !resourceRequest) return undefined;
    try {
      if (config.issuerUrl.protocol === "https:" && !getRequestOriginInfo(request, runtime).secure) {
        oauthError("invalid_request", "HTTPS is required");
      }
      if (resourceRequest && config.handleResource) {
        if (new URL(request.url).searchParams.has("access_token")) {
          return protocolResponse({ error: "invalid_request", error_description: "Use the Authorization header" }, 400);
        }
        const alternative = await config.admitResource?.(request);
        if (alternative !== undefined) {
          if (!(alternative instanceof Response)) throw new TypeError("OAuth resource admission must return a Response or undefined");
          return alternative;
        }
        const result = await authenticate(request);
        if (result instanceof Response) return result;
        const response = await config.handleResource(request, result);
        if (!(response instanceof Response)) throw new TypeError("OAuth resource handler must return a Response");
        return response;
      }
      if (resourceMetadata || asMetadata) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const response = resourceMetadata
          ? protocolResponse({
            resource: config.resource, authorization_servers: [config.issuer],
            bearer_methods_supported: ["header"], scopes_supported: config.resourceScopes.filter(scope => scope !== "offline_access"),
          })
          : protocolResponse({
            issuer: config.issuer, authorization_endpoint: config.authorizationEndpoint,
            token_endpoint: config.tokenEndpoint, revocation_endpoint: config.revocationEndpoint,
            response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"], scopes_supported: Object.keys(config.scopes),
            token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
            revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: false,
          });
        response.headers.set("access-control-allow-origin", "*");
        return response;
      }
      switch (endpoint) {
        case "/authorize": return request.method === "GET" ? await begin(request) : methodNotAllowed(["GET"]);
        case "/consent":
          if (request.method === "GET") return await consentDetails(request);
          return request.method === "POST" ? await consentDecision(request) : methodNotAllowed(["GET", "POST"]);
        case "/token": return request.method === "POST" ? await token(request) : methodNotAllowed(["POST"]);
        case "/revoke": return request.method === "POST" ? await revoke(request) : methodNotAllowed(["POST"]);
        case "/grants": return ["GET", "DELETE"].includes(request.method) ? await grants(request) : methodNotAllowed(["GET", "DELETE"]);
        default: return protocolResponse({ error: "not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof AuthError) {
        const response = protocolResponse({ error: error.code, error_description: error.message }, error.status);
        if (error.code === "invalid_client" && error.status === 401) response.headers.set("www-authenticate", 'Basic realm="oauth"');
        return response;
      }
      if (requestBodyErrorResponse(error)) return protocolResponse({ error: "invalid_request" }, 400);
      // Application/store failures may contain credentials or private consent data.
      return protocolResponse({ error: "server_error" }, 500);
    }
  }

  return {
    resource: config.resource, protectedResourceMetadataUrl: config.protectedResourceMetadataUrl,
    authenticate, handleRequest, consentPath: config.consentPath,
    routePaths: Object.freeze([
      `${config.prefix}/*`, ...(config.handleResource ? [config.resourcePath] : []),
    ]),
  };
}
