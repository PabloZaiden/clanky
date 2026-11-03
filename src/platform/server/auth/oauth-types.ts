import { z } from "zod";
import type { CurrentUser } from "../../contracts";

export type OAuthAuthorizationContext = { [key: string]: z.JSONType };

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  grantTypes?: readonly ("authorization_code" | "refresh_token")[];
  tokenEndpointAuthMethod?: "none" | "client_secret_basic";
  /** SHA-256 hash returned by createOAuthClientSecret(), never an application API key. */
  clientSecretHash?: string;
}

export interface OAuthPrincipal {
  user: CurrentUser;
  clientId: string;
  resource: string;
  scopes: readonly string[];
  authorizationContext: OAuthAuthorizationContext;
  grantId: string;
}

export interface OAuthConsentRequest {
  user: CurrentUser;
  client: Readonly<OAuthClient>;
  resource: string;
  scopes: readonly string[];
}

export interface OAuthConsentInput extends OAuthConsentRequest {
  /** Untrusted application form data. Validate before granting application authority. */
  approval: OAuthAuthorizationContext;
}

export interface OAuthConfig {
  /** Fixed externally visible HTTPS issuer. HTTP is accepted only on loopback. */
  issuer: string;
  /** Exact canonical resource identifier, including its significant path. */
  resource: string;
  scopes: Readonly<Record<string, string>>;
  /** Minimal resource-discovery/challenge scopes; defaults to the described scopes. */
  resourceScopes?: readonly string[];
  /** Resolve application-owned dynamic scope names to human-readable descriptions. */
  resolveScopes?: (requestedScopes: readonly string[]) =>
    false | Readonly<Record<string, string>> | Promise<false | Readonly<Record<string, string>>>;
  clients: readonly OAuthClient[];
  /** Same-origin UI path, optionally with a canonical #/view route; request is added to URL search, preserving the hash. */
  consentPath: string;
  /** Authenticated presentation data only; authorizeConsent must validate the chosen approval independently. */
  getConsentContext?: (input: OAuthConsentRequest) =>
    OAuthAuthorizationContext | Promise<OAuthAuthorizationContext>;
  authorizeConsent: (
    input: OAuthConsentInput,
  ) => false | {
    scopes?: readonly string[];
    authorizationContext?: OAuthAuthorizationContext;
  } | Promise<false | {
    scopes?: readonly string[];
    authorizationContext?: OAuthAuthorizationContext;
  }>;
  /** Reconcile application grants on resource access and refresh. Fail closed. */
  validateAuthorization?: (principal: Readonly<OAuthPrincipal>) => boolean | Promise<boolean>;
  /** Exact-resource composition: return a final response for separately verified admission, or undefined for OAuth. */
  admitResource?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  /** Optional explicit resource mount. No ordinary application route admits OAuth tokens. */
  handleResource?: (request: Request, principal: Readonly<OAuthPrincipal>) =>
    Response | Promise<Response>;
}

export interface OAuthService {
  resource: string;
  protectedResourceMetadataUrl: string;
  /** Resource-only credentials: never use this to issue browser or application API credentials. */
  authenticate(request: Request, requiredScopes?: readonly string[]): Promise<OAuthPrincipal | Response>;
}

const contextSchema = z.record(z.string(), z.json());
const common = {
  issuer: z.string(),
  resource: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
};

export const oauthAuthorizationSchema = z.object({
  ...common,
  requestHash: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopeDescriptions: z.record(z.string(), z.string()),
  state: z.string().optional(),
  /** Request deadline until redemption; consumed-code binding retention ends with the credential family. */
  expiresAt: z.number().finite(),
  status: z.enum(["pending", "approved", "denied", "consumed"]),
  userId: z.string().optional(),
  authVersion: z.number().int().optional(),
  codeHash: z.string().optional(),
  codeExpiresAt: z.number().finite().optional(),
  familyId: z.string().optional(),
  authorizationContext: contextSchema.optional(),
});

export const oauthSessionSchema = z.object({
  ...common,
  id: z.string(),
  familyId: z.string(),
  userId: z.string(),
  authVersion: z.number().int(),
  authorizationContext: contextSchema,
  accessHash: z.string(),
  refreshHash: z.string().optional(),
  accessExpiresAt: z.number().finite(),
  expiresAt: z.number().finite(),
  createdAt: z.number().finite(),
  revokedAt: z.number().finite().optional(),
});

export type OAuthAuthorizationRecord = z.infer<typeof oauthAuthorizationSchema>;
export type OAuthSessionRecord = z.infer<typeof oauthSessionSchema>;

/** Transactions MUST be synchronous, isolated, atomic and roll back on exceptions. */
export interface OAuthStore {
  initialize(): void;
  transaction<T>(operation: () => T): T;
  getAuthorization(requestHash: string): OAuthAuthorizationRecord | undefined;
  getAuthorizationByCode(codeHash: string): OAuthAuthorizationRecord | undefined;
  saveAuthorization(record: OAuthAuthorizationRecord): void;
  getSessionByTokenHash(tokenHash: string): OAuthSessionRecord | undefined;
  saveSession(record: OAuthSessionRecord): void;
  listSessions(userId: string): OAuthSessionRecord[];
  revokeFamily(familyId: string, revokedAt: number): void;
  deleteExpired(now: number): void;
}
