import { z } from "zod";
import { readRequestText } from "@pablozaiden/webapp/server";
import { AuthError } from "./types";
import { secureEqual, sha256 } from "./crypto";
import type { OAuthClient, OAuthConfig } from "./oauth-types";

const scopeSchema = z.string().min(1).max(200).regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/).refine(scope => scope !== "*");

export function oauthError(code: string, message: string, status = 400): never {
  throw new AuthError(code, message, status);
}

function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

export function secureOAuthUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
    || url.username || url.password || value.includes("#") || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("OAuth URLs require HTTPS (HTTP only on loopback), without credentials or fragments");
  }
  return url;
}

export function canonicalOAuthResource(value: string): string {
  const url = secureOAuthUrl(value);
  return `${url.origin}${url.pathname === "/" && !value.replace(/\?.*$/, "").endsWith("/") ? "" : url.pathname}${url.search}`;
}

export function validateOAuthRedirectUri(value: string): void {
  const url = secureOAuthUrl(value);
  if (["code", "state", "iss", "error", "error_description"].some(key => url.searchParams.has(key))) {
    throw new Error("OAuth redirect URIs cannot contain authorization response parameters");
  }
}

export function oauthRedirectMatches(client: OAuthClient, redirectUri: string): boolean {
  if (client.redirectUris.includes(redirectUri)) return true;
  if (!URL.canParse(redirectUri)) return false;
  const requested = new URL(redirectUri);
  if (requested.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(requested.hostname)) return false;
  return client.redirectUris.some(registered => {
    const url = new URL(registered);
    url.port = requested.port;
    return url.href === redirectUri;
  });
}

export function validateOAuthConfig(input: OAuthConfig) {
  const issuerUrl = secureOAuthUrl(input.issuer);
  if (input.issuer.includes("?")) throw new Error("OAuth issuer cannot contain a query");
  const resource = canonicalOAuthResource(input.resource);
  const resourceUrl = new URL(resource);
  const scopes = z.record(scopeSchema, z.string().min(1).max(1000)).parse(input.scopes);
  if (!Object.keys(scopes).length) throw new Error("OAuth requires explicitly described scopes");
  const resourceScopes = z.array(scopeSchema).min(1).parse(input.resourceScopes ?? Object.keys(scopes));
  if (resourceScopes.some(scope => !Object.hasOwn(scopes, scope))) throw new Error("Unknown OAuth resource scope");
  if (resourceScopes.includes("offline_access")) throw new Error("offline_access is not a resource requirement");
  const consent = new URL(input.consentPath, input.issuer);
  if (!input.consentPath.startsWith("/") || input.consentPath.startsWith("//")
    || consent.origin !== issuerUrl.origin || consent.search
    || (consent.hash && !/^#\/[^?#]+$/.test(consent.hash))) {
    throw new Error("OAuth consentPath must be a same-origin path with an optional #/view route, without a query");
  }
  if (typeof input.authorizeConsent !== "function"
    || (input.getConsentContext !== undefined && typeof input.getConsentContext !== "function")
    || (input.resolveScopes !== undefined && typeof input.resolveScopes !== "function")
    || (input.validateAuthorization !== undefined && typeof input.validateAuthorization !== "function")) {
    throw new Error("OAuth requires an application consent callback");
  }
  const base = input.issuer.replace(/\/$/, "");
  const prefix = `${issuerUrl.pathname.replace(/\/$/, "")}/api/oauth`;
  const metadataPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
  const issuerMetadataPath = `/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`;
  if (consent.pathname.startsWith(`${prefix}/`) || consent.pathname.startsWith("/.well-known/")) {
    throw new Error("OAuth consent UI must not shadow protocol endpoints");
  }
  if (resourceUrl.pathname.startsWith(`${prefix}/`) || resourceUrl.pathname.startsWith("/.well-known/")
    || resourceUrl.pathname === consent.pathname) {
    throw new Error("OAuth resource must not shadow protocol or consent endpoints");
  }
  if (input.handleResource !== undefined && typeof input.handleResource !== "function") {
    throw new Error("OAuth handleResource must be a function");
  }
  if (input.admitResource !== undefined && (typeof input.admitResource !== "function" || !input.handleResource)) {
    throw new Error("OAuth admitResource requires a resource handler");
  }
  return {
    issuer: input.issuer, issuerUrl, resource, scopes: Object.freeze(scopes),
    resourceScopes: Object.freeze(resourceScopes),
    consentPath: consent.pathname, consentUrl: consent.href, prefix, metadataPath, issuerMetadataPath,
    protectedResourceMetadataUrl: `${resourceUrl.origin}${metadataPath}`,
    authorizationEndpoint: `${base}/api/oauth/authorize`,
    tokenEndpoint: `${base}/api/oauth/token`,
    revocationEndpoint: `${base}/api/oauth/revoke`,
    registrationEndpoint: `${base}/api/oauth/register`,
    authorizeConsent: input.authorizeConsent,
    getConsentContext: input.getConsentContext,
    resolveScopes: input.resolveScopes,
    validateAuthorization: input.validateAuthorization,
    handleResource: input.handleResource,
    admitResource: input.admitResource,
    resourcePath: resourceUrl.pathname,
  };
}

export type ValidatedOAuthConfig = ReturnType<typeof validateOAuthConfig>;

export function uniqueOAuthParameters(parameters: URLSearchParams): URLSearchParams {
  const seen = new Set<string>();
  for (const key of parameters.keys()) {
    if (seen.has(key)) oauthError("invalid_request", "Duplicate parameters are not allowed");
    seen.add(key);
  }
  return parameters;
}

export async function oauthForm(request: Request): Promise<URLSearchParams> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    oauthError("invalid_request", "Use application/x-www-form-urlencoded");
  }
  return uniqueOAuthParameters(new URLSearchParams(await readRequestText(request, 16 * 1024)));
}

export function oauthScopes(value: string | null): string[] {
  const scopes = value?.split(" ").filter(Boolean) ?? [];
  if (!scopes.length || scopes.length > 50 || scopes.some(scope => !scopeSchema.safeParse(scope).success)) {
    oauthError("invalid_scope", "Request explicit valid scopes");
  }
  return [...new Set(scopes)];
}

export async function describeOAuthScopes(config: ValidatedOAuthConfig, scopes: readonly string[]): Promise<Record<string, string>> {
  const resolved = config.resolveScopes ? await config.resolveScopes(Object.freeze([...scopes])) : {};
  if (resolved === false) oauthError("invalid_scope", "Requested scopes are not available");
  const descriptions = z.record(scopeSchema, z.string().min(1).max(1000)).parse(resolved);
  const result: [string, string][] = [];
  for (const scope of scopes) {
    const description = Object.hasOwn(config.scopes, scope)
      ? config.scopes[scope]
      : Object.hasOwn(descriptions, scope) ? descriptions[scope] : undefined;
    if (!description) oauthError("invalid_scope", "Requested scopes are not available");
    result.push([scope, description]);
  }
  return Object.fromEntries(result);
}

export async function authenticateOAuthClient(
  resolveClient: (clientId: string | null) => Promise<OAuthClient>,
  request: Request,
  parameters: URLSearchParams,
): Promise<OAuthClient> {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    const client = await resolveClient(parameters.get("client_id"));
    if (client.tokenEndpointAuthMethod !== "none" || parameters.has("client_secret")) {
      oauthError("invalid_client", "Client authentication failed", 401);
    }
    return client;
  }
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!basic?.[1] || parameters.has("client_secret")) {
    oauthError("invalid_client", "Client authentication failed", 401);
  }
  let clientId: string;
  let secret: string;
  try {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) throw new Error("Missing separator");
    clientId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
    secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "));
  } catch {
    oauthError("invalid_client", "Client authentication failed", 401);
  }
  const client = await resolveClient(clientId);
  if (parameters.has("client_id") && parameters.get("client_id") !== clientId) {
    oauthError("invalid_client", "Client authentication failed", 401);
  }
  if (client.tokenEndpointAuthMethod !== "client_secret_basic" || !client.clientSecretHash
    || !secureEqual(sha256(secret), client.clientSecretHash)) {
    oauthError("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

export function requireOAuthResource(config: ValidatedOAuthConfig, value: string | null): void {
  let resource: string | undefined;
  try {
    if (value) resource = canonicalOAuthResource(value);
  } catch {
    oauthError("invalid_target", "Invalid resource");
  }
  if (resource !== config.resource) oauthError("invalid_target", "The requested resource is not supported");
}
