import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { z } from "zod";
import { isPublicIpAddress } from "@/shared/ip-address";
import { randomToken, sha256 } from "./crypto";
import { oauthClientSchema, type OAuthClient, type OAuthStore } from "./oauth-types";
import { oauthError, secureOAuthUrl, validateOAuthRedirectUri, type ValidatedOAuthConfig } from "./oauth-validation";
import { AuthError } from "./types";

const MAX_METADATA_BYTES = 16 * 1024;
const metadataSchema = z.object({
  client_name: z.string().trim().min(1).max(200).default("MCP client"),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).min(1).max(2).default(["authorization_code"]),
  response_types: z.array(z.literal("code")).length(1).default(["code"]),
  token_endpoint_auth_method: z.enum(["none", "client_secret_basic"]).default("client_secret_basic"),
});
const documentSchema = metadataSchema.extend({
  client_id: z.string().min(1).max(2048),
  client_name: z.string().trim().min(1).max(200),
  token_endpoint_auth_method: z.literal("none").default("none"),
  client_secret: z.never().optional(),
  client_secret_expires_at: z.never().optional(),
});

export function createOAuthClientSecret(): { secret: string; secretHash: string } {
  const secret = `oauth_secret_${randomToken()}`;
  return { secret, secretHash: sha256(secret) };
}

function clientFromMetadata(metadata: z.infer<typeof metadataSchema>, clientId: string, secretHash?: string): OAuthClient {
  if (!metadata.grant_types.includes("authorization_code")) {
    oauthError("invalid_client_metadata", "Authorization code flow is required");
  }
  for (const uri of metadata.redirect_uris) {
    try { validateOAuthRedirectUri(uri); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      oauthError("invalid_redirect_uri", "Redirect URIs require HTTPS or loopback HTTP, without credentials, fragments or authorization response parameters");
    }
  }
  return oauthClientSchema.parse({
    clientId, clientName: metadata.client_name, redirectUris: metadata.redirect_uris,
    grantTypes: [...new Set(metadata.grant_types)], tokenEndpointAuthMethod: metadata.token_endpoint_auth_method,
    ...(secretHash ? { clientSecretHash: secretHash } : {}),
  });
}

function metadataUrl(value: string): URL {
  let url: URL;
  try { url = secureOAuthUrl(value); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    oauthError("invalid_client", "Client metadata requires an HTTPS URL", 400);
  }
  if (url.protocol !== "https:" || !/^https:\/\/[^/?#]+\//i.test(value)
    || value.split(/[?#]/, 1)[0]!.split("/").some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    oauthError("invalid_client", "Client metadata requires an HTTPS URL with a path and no dot segments", 400);
  }
  return url;
}

function requestMetadata(url: URL, issuerOrigin: string, signal: AbortSignal): Promise<IncomingMessage> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // The operator-selected issuer may intentionally use a private network.
  const trustedOrigin = url.origin === issuerOrigin;
  if (!trustedOrigin && isIP(hostname) && !isPublicIpAddress(hostname)) {
    oauthError("invalid_client", "Client metadata must be hosted on a public network", 400);
  }
  const publicLookup: NonNullable<RequestOptions["lookup"]> = (_hostname, options, callback) => {
    void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
      // Pin the validated address to prevent a second DNS lookup from rebinding.
      if (!addresses.length || !trustedOrigin && addresses.some(entry => !isPublicIpAddress(entry.address))) {
        callback(new AuthError("invalid_client", "Client metadata must be hosted on a public network", 400), "", 4);
      } else if (options.all) {
        callback(null, [addresses[0]!]);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    }, () => callback(new AuthError("invalid_client", "Unable to resolve the client metadata host", 400), "", 4));
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET", signal, agent: false, lookup: publicLookup,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      maxHeaderSize: MAX_METADATA_BYTES,
    }, resolve);
    request.once("error", error => reject(error instanceof AuthError ? error
      : new AuthError("invalid_client", "Unable to retrieve client metadata securely", 400)));
    request.end();
  });
}

function cacheLifetime(response: IncomingMessage): number {
  const control = response.headers["cache-control"] ?? "";
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(control) || response.headers["vary"] === "*") return 0;
  const age = Number(response.headers["age"] ?? 0);
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(control)?.[1];
  const expires = response.headers["expires"];
  const seconds = maxAge !== undefined ? Number(maxAge) - age
    : expires ? (Date.parse(expires) - Date.now()) / 1000 : 300 - age;
  return Number.isFinite(seconds) ? Math.max(0, Math.min(3600, seconds)) * 1000 : 0;
}

async function fetchMetadata(clientId: string, issuerOrigin: string, signal?: AbortSignal): Promise<{
  client: OAuthClient; cacheUntil: number;
}> {
  const timeout = AbortSignal.timeout(5000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = metadataUrl(clientId);
  for (let redirects = 0; ; redirects++) {
    const response = await requestMetadata(url, issuerOrigin, requestSignal);
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (redirects >= 3 || !response.headers.location) oauthError("invalid_client", "Too many client metadata redirects", 400);
        if (!URL.canParse(response.headers.location, url)) oauthError("invalid_client", "Client metadata redirect URL is invalid", 400);
        url = metadataUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (response.statusCode !== 200) oauthError("invalid_client", "Client metadata could not be retrieved", 400);
      const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType)) {
        oauthError("invalid_client", "Client metadata must be JSON", 400);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of response) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_METADATA_BYTES) oauthError("invalid_client", "Client metadata is too large", 400);
          chunks.push(buffer);
        }
      } catch (error) {
        if (error instanceof AuthError) throw error;
        if (requestSignal.aborted || error instanceof Error && "code" in error
          && ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "EPIPE"].includes(String(error.code))) {
          oauthError("invalid_client", "Client metadata response was interrupted or timed out", 400);
        }
        throw error;
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        oauthError("invalid_client", "Client metadata is not valid JSON", 400);
      }
      const parsed = documentSchema.safeParse(value);
      if (!parsed.success || parsed.data.client_id !== clientId) {
        oauthError("invalid_client", "Client metadata must describe the exact client ID and a supported public client", 400);
      }
      return {
        client: clientFromMetadata(parsed.data, clientId),
        cacheUntil: Date.now() + cacheLifetime(response),
      };
    } finally { response.destroy(); }
  }
}

export function createOAuthClients(config: ValidatedOAuthConfig, store: OAuthStore) {
  const cache = new Map<string, { client: OAuthClient; cacheUntil: number }>();
  return {
    register(value: unknown) {
      const parsed = metadataSchema.safeParse(value);
      if (!parsed.success) oauthError("invalid_client_metadata", "Provide valid redirect URIs, grant types and a supported authentication method");
      const metadata = parsed.data;
      const secret = metadata.token_endpoint_auth_method === "client_secret_basic" ? createOAuthClientSecret() : undefined;
      const client = clientFromMetadata(metadata, `oauth_client_${randomToken()}`, secret?.secretHash);
      store.transaction(() => store.saveClient(config.issuer, client));
      return {
        client_id: client.clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.clientName, redirect_uris: client.redirectUris, grant_types: client.grantTypes,
        response_types: metadata.response_types, token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        ...(secret ? { client_secret: secret.secret, client_secret_expires_at: 0 } : {}),
      };
    },
    async resolve(clientId: string | null, signal?: AbortSignal): Promise<OAuthClient> {
      if (!clientId || clientId.length > 2048) oauthError("invalid_client", "Provide a valid client ID", 401);
      const registered = store.getClient(config.issuer, clientId);
      if (registered) return registered;
      const cached = cache.get(clientId);
      if (cached && cached.cacheUntil > Date.now()) return cached.client;
      cache.delete(clientId);
      const resolved = await fetchMetadata(clientId, config.issuerUrl.origin, signal);
      if (resolved.cacheUntil > Date.now()) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(clientId, resolved);
      }
      return resolved.client;
    },
  };
}
