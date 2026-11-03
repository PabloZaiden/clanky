import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import type { AuthSessionSummary, CurrentUser, DeviceAuthorizationResponse, DeviceVerificationDetails, TokenResponse } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import type { DeviceAuthExchangeCandidate, RefreshSessionRecord, SigningKeyRecord, ClankyAccountStore } from "./store";
import { addSeconds, isExpired, nowIso, randomToken, sha256 } from "./crypto";
import { getRequestBaseUrl } from "@pablozaiden/webapp/server";
import { AuthError, type AccessTokenClaims } from "./types";
import { toCurrentUser } from "./users";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 10;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEVICE_CODE_TTL_SECONDS = 60 * 10;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface SigningKeyPair {
  alg: string;
  kid: string;
  publicJwk: JWK;
  privateJwk: JWK;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

function generateUserCode(): string {
  const chars: string[] = [];
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const byte of bytes) {
    chars.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]!);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function getPublicBaseUrl(req: Request, config: RuntimeConfig): string {
  return getRequestBaseUrl(req, config);
}

function deviceVerificationDetails(record: {
  userCode: string;
  clientId: string;
  scope: string;
  status: DeviceVerificationDetails["status"];
  expiresAt: string;
}, passkeyRequired: boolean): DeviceVerificationDetails {
  return {
    userCode: record.userCode,
    clientId: record.clientId,
    scope: record.scope,
    status: record.status,
    expiresAt: record.expiresAt,
    passkeyRequired,
  };
}

async function createSigningKey(): Promise<SigningKeyPair> {
  try {
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const privateJwk = await exportJWK(pair.privateKey);
    const kid = crypto.randomUUID();
    return { alg: "EdDSA", kid, publicJwk, privateJwk, publicKey: pair.publicKey, privateKey: pair.privateKey };
  } catch {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const privateJwk = await exportJWK(pair.privateKey);
    const kid = crypto.randomUUID();
    return { alg: "ES256", kid, publicJwk, privateJwk, publicKey: pair.publicKey, privateKey: pair.privateKey };
  }
}

async function importSigningKey(stored: SigningKeyRecord): Promise<SigningKeyPair> {
  return {
    alg: stored.alg,
    kid: stored.kid,
    publicJwk: stored.publicJwk as JWK,
    privateJwk: stored.privateJwk as JWK,
    publicKey: await importJWK(stored.publicJwk as JWK, stored.alg) as CryptoKey,
    privateKey: await importJWK(stored.privateJwk as JWK, stored.alg) as CryptoKey,
  };
}

async function getSigningKey(store: ClankyAccountStore): Promise<SigningKeyPair> {
  const existing = store.getSigningKey();
  if (existing) {
    return importSigningKey(existing);
  }
  const created = await createSigningKey();
  const stored = store.getOrCreateSigningKey({
    alg: created.alg,
    kid: created.kid,
    publicJwk: created.publicJwk as Record<string, unknown>,
    privateJwk: created.privateJwk as Record<string, unknown>,
    createdAt: nowIso(),
  });
  return importSigningKey(stored);
}

function issuer(config: RuntimeConfig): string {
  return config.authIssuer || `urn:${config.envPrefix.toLowerCase()}:webapp`;
}

async function issueAccessToken(store: ClankyAccountStore, config: RuntimeConfig, input: {
  sessionId: string;
  user: CurrentUser;
  clientId: string;
  scope: string;
}): Promise<{ accessToken: string; jti: string }> {
  const key = await getSigningKey(store);
  const jti = crypto.randomUUID();
  const token = await new SignJWT({
    sid: input.sessionId,
    clientId: input.clientId,
    scope: input.scope,
    username: input.user.username,
    role: input.user.role,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setSubject(input.user.id)
    .setJti(jti)
    .setIssuer(issuer(config))
    .setAudience(`${config.envPrefix.toLowerCase()}-api`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key.privateKey);
  return { accessToken: token, jti };
}

function tokenSet(accessToken: string, refreshToken: string, scope: string): TokenResponse {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
}

export function createDeviceAuthorization(req: Request, store: ClankyAccountStore, config: RuntimeConfig, input: { clientId?: string; scope?: string } = {}): DeviceAuthorizationResponse {
  store.deleteExpiredDeviceAuthRequests(nowIso());
  const deviceCode = randomToken(32);
  let userCode = generateUserCode();
  while (store.getDeviceAuthByUserCode(userCode)) {
    userCode = generateUserCode();
  }
  const baseUrl = getPublicBaseUrl(req, config);
  const record = {
    deviceCodeHash: sha256(deviceCode),
    userCode,
    clientId: input.clientId?.trim() || `${config.envPrefix.toLowerCase()}-cli`,
    scope: input.scope?.trim() || "*",
    status: "pending" as const,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: addSeconds(DEVICE_CODE_TTL_SECONDS),
  };
  store.saveDeviceAuthRequest(record);
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${baseUrl}/device`,
    verification_uri_complete: `${baseUrl}/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

export function getDeviceVerificationDetails(store: ClankyAccountStore, userCode: string, passkeyRequired: boolean): DeviceVerificationDetails {
  const record = store.getDeviceAuthByUserCode(userCode);
  if (!record || isExpired(record.expiresAt)) {
    throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
  }
  return deviceVerificationDetails(record, passkeyRequired);
}

export function approveDevice(store: ClankyAccountStore, userCode: string, userId: string): DeviceVerificationDetails {
  const result = store.approveDeviceAuth(userCode, userId, nowIso());
  switch (result.kind) {
    case "approved":
    case "already_approved":
      return deviceVerificationDetails(result.record, false);
    case "not_found":
    case "expired":
      throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
    case "denied":
    case "consumed":
    case "conflict":
      throw new AuthError("invalid_request", "Device authorization can no longer be approved", 400);
  }
}

export function denyDevice(store: ClankyAccountStore, userCode: string): DeviceVerificationDetails {
  const result = store.denyDeviceAuth(userCode, nowIso());
  switch (result.kind) {
    case "denied":
    case "already_denied":
      return deviceVerificationDetails(result.record, false);
    case "not_found":
    case "expired":
      throw new AuthError("invalid_user_code", "Device authorization code is invalid or expired", 404);
    case "approved":
    case "consumed":
    case "conflict":
      throw new AuthError("invalid_request", "Device authorization can no longer be denied", 400);
  }
}

function createRefreshRecord(userId: string, clientId: string, scope: string, familyId: string = crypto.randomUUID()): { token: string; record: RefreshSessionRecord } {
  const token = randomToken(32);
  const createdAt = nowIso();
  const id = crypto.randomUUID();
  return {
    token,
    record: {
      id,
      userId,
      familyId,
      clientId,
      scope,
      refreshTokenHash: sha256(token),
      createdAt,
      updatedAt: createdAt,
      expiresAt: addSeconds(REFRESH_TOKEN_TTL_SECONDS),
    },
  };
}

function createDeviceRefreshCandidate(clientId: string, scope: string, userId?: string): { token: string; record: DeviceAuthExchangeCandidate } {
  const refresh = createRefreshRecord(userId ?? "", clientId, scope);
  return {
    token: refresh.token,
    record: { ...refresh.record, userId: userId || undefined },
  };
}

function activeRefreshSessions(store: ClankyAccountStore, userId: string): RefreshSessionRecord[] {
  return store.listRefreshSessions(userId)
    .filter((session) => !session.revokedAt && !isExpired(session.expiresAt))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function uniqueActiveClientSessions(store: ClankyAccountStore, userId: string): RefreshSessionRecord[] {
  const seenClientIds = new Set<string>();
  const sessions: RefreshSessionRecord[] = [];
  const duplicateRevokedAt = nowIso();
  for (const session of activeRefreshSessions(store, userId)) {
    if (seenClientIds.has(session.clientId)) {
      store.revokeRefreshSession(session.id, duplicateRevokedAt, userId);
    } else {
      seenClientIds.add(session.clientId);
      sessions.push(session);
    }
  }
  return sessions;
}

export async function exchangeDeviceCode(store: ClankyAccountStore, config: RuntimeConfig, deviceCode: string, clientId?: string): Promise<TokenResponse> {
  const deviceCodeHash = sha256(deviceCode);
  const record = store.getDeviceAuthByDeviceCodeHash(deviceCodeHash);
  if (!record) {
    throw new AuthError("invalid_grant", "Device code is invalid", 400);
  }
  const refresh = createDeviceRefreshCandidate(record.clientId, record.scope, record.approvedByUserId);
  const result = store.exchangeDeviceAuth(deviceCodeHash, clientId, refresh.record, nowIso());
  switch (result.kind) {
    case "not_found":
      throw new AuthError("invalid_grant", "Device code is invalid", 400);
    case "pending":
      throw new AuthError("authorization_pending", "Device authorization is still pending", 400);
    case "denied":
      throw new AuthError("access_denied", "Device authorization was denied", 400);
    case "expired":
      throw new AuthError("expired_token", "Device code has expired", 400);
    case "consumed":
      throw new AuthError("invalid_grant", "Device code has already been used", 400);
    case "client_mismatch":
      throw new AuthError("invalid_client", "client_id does not match device authorization", 400);
    case "missing_user":
      throw new AuthError("invalid_grant", "Approving user no longer exists", 400);
    case "disabled_user":
      throw new AuthError("invalid_grant", "Approving user is disabled", 400);
    case "conflict":
      throw new AuthError("invalid_grant", "Device authorization could not be completed", 400);
    case "exchanged": {
      const access = await issueAccessToken(store, config, {
        sessionId: result.session.id,
        user: toCurrentUser(result.user),
        clientId: result.session.clientId,
        scope: result.session.scope,
      });
      return tokenSet(access.accessToken, refresh.token, result.session.scope);
    }
  }
}

export async function exchangeRefreshToken(store: ClankyAccountStore, config: RuntimeConfig, refreshToken: string, clientId?: string): Promise<TokenResponse> {
  const hash = sha256(refreshToken);
  const session = store.getRefreshSessionByHash(hash);
  if (!session) {
    throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
  }
  const next = createRefreshRecord(session.userId, session.clientId, session.scope, session.familyId);
  const result = store.rotateRefreshSession(hash, next.record, nowIso(), clientId);
  switch (result.kind) {
    case "not_found":
      throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
    case "expired":
      throw new AuthError("invalid_grant", "Refresh token has expired", 400);
    case "client_mismatch":
      throw new AuthError("invalid_client", "client_id does not match refresh session", 400);
    case "replayed":
      throw new AuthError("invalid_grant", "Refresh token has been revoked", 400);
    case "missing_user":
      throw new AuthError("invalid_grant", "Refresh token user no longer exists", 400);
    case "disabled_user":
      throw new AuthError("invalid_grant", "Refresh token user is disabled", 400);
    case "conflict":
      throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
    case "rotated": {
      const access = await issueAccessToken(store, config, {
        sessionId: result.session.id,
        user: toCurrentUser(result.user),
        clientId: result.session.clientId,
        scope: result.session.scope,
      });
      return tokenSet(access.accessToken, next.token, result.session.scope);
    }
  }
}

export async function verifyAccessToken(store: ClankyAccountStore, config: RuntimeConfig, token: string): Promise<AccessTokenClaims> {
  const key = await getSigningKey(store);
  const result = await jwtVerify(token, key.publicKey, {
    issuer: issuer(config),
    audience: `${config.envPrefix.toLowerCase()}-api`,
  });
  const payload = result.payload;
  const userId = payload.sub ?? "";
  const sessionId = typeof payload["sid"] === "string" ? payload["sid"] : "";
  const session = store.getRefreshSession(sessionId, userId);
  if (
    !session || session.revokedAt || isExpired(session.expiresAt)
    || session.clientId !== payload["clientId"] || session.scope !== payload["scope"]
  ) {
    throw new AuthError("invalid_token", "Authentication session is no longer active", 401);
  }
  return {
    sub: userId,
    username: typeof payload["username"] === "string" ? payload["username"] : undefined,
    role: typeof payload["role"] === "string" ? payload["role"] : undefined,
    jti: payload.jti ?? "",
    sid: sessionId,
    clientId: String(payload["clientId"] ?? ""),
    scope: String(payload["scope"] ?? ""),
  };
}

export function listAuthSessions(store: ClankyAccountStore, userId: string): AuthSessionSummary[] {
  store.deleteExpiredRefreshSessions?.(nowIso());
  return uniqueActiveClientSessions(store, userId)
    .map((session) => ({
      id: session.id,
      clientId: session.clientId,
      scope: session.scope,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      revokedAt: session.revokedAt,
      active: true,
    }));
}

export function revokeAuthSession(store: ClankyAccountStore, userId: string, id: string): boolean {
  return store.revokeRefreshSession(id, nowIso(), userId);
}

export function revokeRefreshToken(store: ClankyAccountStore, refreshToken: string): boolean {
  const session = store.getRefreshSessionByHash(sha256(refreshToken));
  return session ? store.revokeRefreshSession(session.id, nowIso()) : false;
}

export async function jwks(store: ClankyAccountStore) {
  const key = await getSigningKey(store);
  return {
    keys: [{
      ...key.publicJwk,
      kid: key.kid,
      alg: key.alg,
      use: "sig",
    }],
  };
}

export function discovery(req: Request, config: RuntimeConfig) {
  const base = getPublicBaseUrl(req, config);
  return {
    issuer: issuer(config),
    jwks_uri: `${base}/.well-known/jwks.json`,
    device_authorization_endpoint: `${base}/api/auth/device`,
    token_endpoint: `${base}/api/auth/token`,
    revocation_endpoint: `${base}/api/auth/revoke`,
  };
}
