/**
 * Device authorization and bearer-token runtime helpers.
 */

import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import {
  consumeApprovedDeviceAuthRequest,
  createDeviceAuthRequest,
  getAuthInstanceId,
  getCanonicalIssuer,
  getDeviceAuthRequestByDeviceCodeHash,
  getDeviceAuthRequestByUserCode,
  getRefreshSessionById,
  getRefreshSessionByTokenHash,
  getStoredSigningKey,
  hashOpaqueToken,
  listLatestRefreshSessions,
  revokeRefreshFamily,
  revokeRefreshSession,
  rotateRefreshSessionAtomically,
  saveStoredSigningKey,
  setAuthInstanceId,
  setCanonicalIssuer,
  touchRefreshSession,
  updateDeviceAuthRequest,
  type CreateRefreshSessionInput,
  type DeviceAuthRequestRecord,
  type RefreshSessionRecord,
  type StoredSigningKey,
} from "../persistence/auth";
import { createLogger } from "./logger";
import { getEffectiveRequestOriginInfo } from "../utils/request-origin";
import { getPublicBasePathFromForwardedPrefix } from "../utils/public-base-path";
import { isPasskeyAuthRequired, isPasskeySessionAuthenticated } from "./passkey-auth";

const log = createLogger("core:token-auth");

const AUTH_SUBJECT = "clanky-user";
const DEFAULT_CLIENT_ID = "clanky-cli";
const ACCESS_TOKEN_AUDIENCE = "clanky-api";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 10;
const REFRESH_SESSION_TOUCH_THROTTLE_MS = 60 * 1000;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEVICE_CODE_TTL_SECONDS = 60 * 10;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_BLOCK_SIZE = 4;
const USER_CODE_BLOCKS = 2;

type SigningKeyPair = {
  material: StoredSigningKey;
  publicKey: Awaited<ReturnType<typeof importJWK>>;
  privateKey: Awaited<ReturnType<typeof importJWK>>;
};

export interface AccessTokenClaims {
  sub: string;
  jti: string;
  sid: string;
  clientId: string;
  scope: string;
}

export interface DeviceAuthorizationStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceVerificationDetails {
  userCode: string;
  clientId: string;
  scope: string;
  status: DeviceAuthRequestRecord["status"];
  expiresAt: string;
  passkeyRequired: boolean;
}

export interface TokenExchangeSuccess {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

export interface AuthSessionSummary {
  id: string;
  clientId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  active: boolean;
}

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

function generateOpaqueToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeCanonicalIssuer(rawValue?: string | null): string | undefined {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!isHttpUrl(trimmed)) {
    throw new AuthError("invalid_issuer", "Canonical issuer must be an absolute http or https URL", 400);
  }
  return trimmed.replace(/\/+$/, "");
}

function getNow(): Date {
  return new Date();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() <= Date.now();
}

function getRequestPublicBaseUrl(req: Request): string {
  const origin = getEffectiveRequestOriginInfo(req).origin;
  const basePath = getPublicBasePathFromForwardedPrefix(req.headers.get("x-forwarded-prefix"));
  return `${origin}${basePath}`;
}

function generateUserCode(): string {
  const chars: string[] = [];
  for (let index = 0; index < USER_CODE_BLOCK_SIZE * USER_CODE_BLOCKS; index += 1) {
    const randomByte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
    const randomIndex = randomByte % USER_CODE_ALPHABET.length;
    chars.push(USER_CODE_ALPHABET[randomIndex]!);
  }
  return [
    chars.slice(0, USER_CODE_BLOCK_SIZE).join(""),
    chars.slice(USER_CODE_BLOCK_SIZE).join(""),
  ].join("-");
}

async function createSigningKeyMaterial(): Promise<StoredSigningKey> {
  try {
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    return {
      alg: "EdDSA",
      kid: crypto.randomUUID(),
      publicJwk: await exportJWK(pair.publicKey) as Record<string, string>,
      privateJwk: await exportJWK(pair.privateKey) as Record<string, string>,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    log.warn("EdDSA key generation failed; falling back to ES256", { error: String(error) });
    const pair = await generateKeyPair("ES256", { extractable: true });
    return {
      alg: "ES256",
      kid: crypto.randomUUID(),
      publicJwk: await exportJWK(pair.publicKey) as Record<string, string>,
      privateJwk: await exportJWK(pair.privateKey) as Record<string, string>,
      createdAt: new Date().toISOString(),
    };
  }
}

async function loadSigningKeyPair(material: StoredSigningKey): Promise<SigningKeyPair> {
  const publicKey = await importJWK(material.publicJwk, material.alg);
  const privateKey = await importJWK(material.privateJwk, material.alg);
  return { material, publicKey, privateKey };
}

async function getOrCreateSigningKeyPair(): Promise<SigningKeyPair> {
  const stored = await getStoredSigningKey();
  if (stored) {
    return await loadSigningKeyPair(stored);
  }

  const material = await createSigningKeyMaterial();
  await saveStoredSigningKey(material);
  return await loadSigningKeyPair(material);
}

async function getOrCreateInstanceId(): Promise<string> {
  const existing = await getAuthInstanceId();
  if (existing) {
    return existing;
  }
  const instanceId = crypto.randomUUID();
  await setAuthInstanceId(instanceId);
  return instanceId;
}

async function getEffectiveIssuer(): Promise<string> {
  const canonical = normalizeCanonicalIssuer(await getCanonicalIssuer());
  if (canonical) {
    return canonical;
  }
  const instanceId = await getOrCreateInstanceId();
  return `urn:clanky:instance:${instanceId}`;
}

function assertPasskeyBackedAuthEnabled(passkeyRequired: boolean): void {
  if (!passkeyRequired) {
    throw new AuthError(
      "passkey_auth_not_configured",
      "Device authorization requires an active passkey-protected browser flow.",
      409,
    );
  }
}

function getNormalizedClientId(clientId?: string): string {
  const trimmed = clientId?.trim();
  return trimmed || DEFAULT_CLIENT_ID;
}

function createRefreshSessionSummary(session: RefreshSessionRecord): AuthSessionSummary {
  return {
    id: session.id,
    clientId: session.clientId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.refreshExpiresAt,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    revocationReason: session.revocationReason,
    active: !session.revokedAt && !isExpired(session.refreshExpiresAt),
  };
}

async function issueAccessToken(session: RefreshSessionRecord, scope: string): Promise<string> {
  const issuer = await getEffectiveIssuer();
  const signingKey = await getOrCreateSigningKeyPair();
  const issuedAt = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    client_id: session.clientId,
    scope,
    sid: session.id,
  })
    .setProtectedHeader({
      alg: signingKey.material.alg,
      kid: signingKey.material.kid,
      typ: "JWT",
    })
    .setIssuer(issuer)
    .setSubject(session.subject)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(signingKey.privateKey);
}

async function createRefreshSessionRecord(
  clientId: string,
  scope: string,
  familyId?: string,
  parentSessionId?: string,
): Promise<{ session: RefreshSessionRecord; createInput: CreateRefreshSessionInput; refreshToken: string }> {
  const refreshToken = generateOpaqueToken(32);
  const sessionId = crypto.randomUUID();
  const resolvedFamilyId = familyId ?? crypto.randomUUID();
  const now = getNow().toISOString();
  const refreshExpiresAt = addSeconds(getNow(), REFRESH_TOKEN_TTL_SECONDS).toISOString();
  const createInput: CreateRefreshSessionInput = {
    id: sessionId,
    familyId: resolvedFamilyId,
    subject: AUTH_SUBJECT,
    clientId,
    scope,
    refreshTokenHash: hashOpaqueToken(refreshToken),
    refreshExpiresAt,
    parentSessionId,
  };
  const session: RefreshSessionRecord = {
    id: sessionId,
    familyId: resolvedFamilyId,
    subject: createInput.subject,
    clientId: createInput.clientId,
    scope: createInput.scope,
    refreshTokenHash: createInput.refreshTokenHash,
    refreshExpiresAt: createInput.refreshExpiresAt,
    parentSessionId,
    createdAt: now,
    updatedAt: now,
  };
  return {
    session,
    createInput,
    refreshToken,
  };
}

export async function getTokenIssuerSettings(): Promise<{
  canonicalIssuer: string | null;
  effectiveIssuer: string;
}> {
  const canonicalIssuer = normalizeCanonicalIssuer(await getCanonicalIssuer()) ?? null;
  return {
    canonicalIssuer,
    effectiveIssuer: await getEffectiveIssuer(),
  };
}

export async function updateTokenIssuerSettings(canonicalIssuer: string | null): Promise<{
  canonicalIssuer: string | null;
  effectiveIssuer: string;
}> {
  await setCanonicalIssuer(normalizeCanonicalIssuer(canonicalIssuer) ?? undefined);
  return await getTokenIssuerSettings();
}

export async function createDeviceAuthorizationRequest(
  req: Request,
  input: { clientId?: string; scope?: string } = {},
): Promise<DeviceAuthorizationStartResult> {
  const passkeyRequired = await isPasskeyAuthRequired();
  assertPasskeyBackedAuthEnabled(passkeyRequired);

  const publicBaseUrl = getRequestPublicBaseUrl(req);
  const deviceCode = generateOpaqueToken(32);
  const userCode = generateUserCode();
  const scope = input.scope?.trim() || "";
  const clientId = getNormalizedClientId(input.clientId);
  const expiresAt = addSeconds(getNow(), DEVICE_CODE_TTL_SECONDS).toISOString();

  await createDeviceAuthRequest({
    id: crypto.randomUUID(),
    clientId,
    deviceCodeHash: hashOpaqueToken(deviceCode),
    userCode,
    scope,
    status: "pending",
    expiresAt,
    pollCount: 0,
  });

  const verificationUri = `${publicBaseUrl}/device`;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

export async function getDeviceVerificationDetails(userCode: string): Promise<DeviceVerificationDetails> {
  const request = await getDeviceAuthRequestByUserCode(userCode.trim().toUpperCase());
  if (!request) {
    throw new AuthError("invalid_user_code", "Device authorization request not found", 404);
  }

  return {
    userCode: request.userCode,
    clientId: request.clientId,
    scope: request.scope,
    status: request.status,
    expiresAt: request.expiresAt,
    passkeyRequired: await isPasskeyAuthRequired(),
  };
}

export async function approveDeviceAuthorizationRequest(req: Request, userCode: string): Promise<DeviceVerificationDetails> {
  const normalizedUserCode = userCode.trim().toUpperCase();
  const request = await getDeviceAuthRequestByUserCode(normalizedUserCode);
  if (!request) {
    throw new AuthError("invalid_user_code", "Device authorization request not found", 404);
  }
  if (!await isPasskeySessionAuthenticated(req)) {
    throw new AuthError("authentication_required", "Passkey authentication is required", 401);
  }
  if (isExpired(request.expiresAt)) {
    throw new AuthError("expired_token", "Device authorization request has expired", 400);
  }
  if (request.status === "approved" || request.status === "consumed") {
    return await getDeviceVerificationDetails(normalizedUserCode);
  }

  await updateDeviceAuthRequest(request.id, {
    status: "approved",
    approvedAt: new Date().toISOString(),
    subject: AUTH_SUBJECT,
  });

  return await getDeviceVerificationDetails(normalizedUserCode);
}

export async function denyDeviceAuthorizationRequest(req: Request, userCode: string): Promise<DeviceVerificationDetails> {
  const normalizedUserCode = userCode.trim().toUpperCase();
  const request = await getDeviceAuthRequestByUserCode(normalizedUserCode);
  if (!request) {
    throw new AuthError("invalid_user_code", "Device authorization request not found", 404);
  }
  if (!await isPasskeySessionAuthenticated(req)) {
    throw new AuthError("authentication_required", "Passkey authentication is required", 401);
  }

  await updateDeviceAuthRequest(request.id, {
    status: "denied",
    deniedAt: new Date().toISOString(),
  });

  return await getDeviceVerificationDetails(normalizedUserCode);
}

export async function exchangeDeviceCode(input: {
  clientId?: string;
  deviceCode: string;
}): Promise<TokenExchangeSuccess> {
  const request = await getDeviceAuthRequestByDeviceCodeHash(hashOpaqueToken(input.deviceCode));
  if (!request) {
    throw new AuthError("invalid_grant", "Device code is invalid", 400);
  }

  if (request.clientId !== getNormalizedClientId(input.clientId)) {
    throw new AuthError("invalid_client", "client_id does not match the device authorization request", 400);
  }

  if (isExpired(request.expiresAt)) {
    throw new AuthError("expired_token", "Device authorization request has expired", 400);
  }

  const now = new Date().toISOString();
  if (request.lastPolledAt) {
    const elapsedMs = Date.now() - new Date(request.lastPolledAt).getTime();
    if (elapsedMs < DEVICE_POLL_INTERVAL_SECONDS * 1000) {
      await updateDeviceAuthRequest(request.id, {
        lastPolledAt: now,
        pollCount: request.pollCount + 1,
      });
      throw new AuthError("slow_down", "Poll interval exceeded", 400);
    }
  }

  await updateDeviceAuthRequest(request.id, {
    lastPolledAt: now,
    pollCount: request.pollCount + 1,
  });

  if (request.status === "pending") {
    throw new AuthError("authorization_pending", "Device authorization is still pending", 400);
  }
  if (request.status === "denied") {
    throw new AuthError("access_denied", "Device authorization was denied", 400);
  }
  if (request.status === "consumed") {
    throw new AuthError("invalid_grant", "Device code has already been used", 400);
  }

  const created = await createRefreshSessionRecord(request.clientId, request.scope);
  const accessToken = await issueAccessToken(created.session, request.scope);
  const consumed = await consumeApprovedDeviceAuthRequest(request.id, created.createInput);
  if (!consumed) {
    throw new AuthError("invalid_grant", "Device code has already been used", 400);
  }

  return {
    accessToken,
    refreshToken: created.refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: request.scope,
  };
}

export async function exchangeRefreshToken(input: {
  clientId?: string;
  refreshToken: string;
}): Promise<TokenExchangeSuccess> {
  const session = await getRefreshSessionByTokenHash(hashOpaqueToken(input.refreshToken));
  if (!session) {
    throw new AuthError("invalid_grant", "Refresh token is invalid", 400);
  }
  if (session.clientId !== getNormalizedClientId(input.clientId)) {
    throw new AuthError("invalid_client", "client_id does not match the refresh token", 400);
  }

  if (session.revokedAt) {
    if (session.revocationReason === "rotated") {
      await revokeRefreshFamily(session.familyId, "reuse_detected");
    }
    throw new AuthError("invalid_grant", "Refresh token has already been revoked", 400);
  }

  if (isExpired(session.refreshExpiresAt)) {
    await revokeRefreshSession(session.id, "expired");
    throw new AuthError("invalid_grant", "Refresh token has expired", 400);
  }

  const next = await createRefreshSessionRecord(session.clientId, session.scope, session.familyId, session.id);
  const accessToken = await issueAccessToken(next.session, session.scope);
  const rotated = await rotateRefreshSessionAtomically(session.id, next.createInput);
  if (!rotated) {
    await revokeRefreshFamily(session.familyId, "reuse_detected");
    throw new AuthError("invalid_grant", "Refresh token reuse detected; token family has been revoked", 400);
  }

  return {
    accessToken,
    refreshToken: next.refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: session.scope,
  };
}

export async function revokeAuthSession(input: { sessionId?: string; refreshToken?: string }): Promise<void> {
  const session = input.sessionId
    ? await getRefreshSessionById(input.sessionId)
    : input.refreshToken
      ? await getRefreshSessionByTokenHash(hashOpaqueToken(input.refreshToken))
      : undefined;

  if (!session) {
    throw new AuthError("session_not_found", "Auth session not found", 404);
  }

  await revokeRefreshFamily(session.familyId, "manual");
}

export async function listAuthSessions(): Promise<AuthSessionSummary[]> {
  const sessions = await listLatestRefreshSessions();
  return sessions.map(createRefreshSessionSummary);
}

export async function getDiscoveryDocument(req: Request): Promise<Record<string, unknown>> {
  const issuer = await getEffectiveIssuer();
  const baseUrl = isHttpUrl(issuer) ? issuer : getRequestPublicBaseUrl(req);
  return {
    issuer,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    token_endpoint: `${baseUrl}/api/auth/token`,
    device_authorization_endpoint: `${baseUrl}/api/auth/device`,
    revocation_endpoint: `${baseUrl}/api/auth/revoke`,
    grant_types_supported: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    response_types_supported: [],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export async function getPublicJwks(): Promise<{ keys: Array<Record<string, string>> }> {
  const signingKey = await getOrCreateSigningKeyPair();
  return {
    keys: [
      {
        ...signingKey.material.publicJwk,
        alg: signingKey.material.alg,
        kid: signingKey.material.kid,
        use: "sig",
      },
    ],
  };
}

export async function validateAccessToken(token: string): Promise<AccessTokenClaims> {
  const signingKey = await getOrCreateSigningKeyPair();
  const issuer = await getEffectiveIssuer();
  let verification;
  try {
    verification = await jwtVerify(token, signingKey.publicKey, {
      issuer,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  } catch (error) {
    throw new AuthError("invalid_token", String(error), 401);
  }

  const payload = verification.payload as JWTPayload & {
    client_id?: unknown;
    scope?: unknown;
    sid?: unknown;
  };
  if (
    typeof payload.sub !== "string"
    || typeof payload.jti !== "string"
    || typeof payload.sid !== "string"
    || typeof payload.client_id !== "string"
    || typeof payload.scope !== "string"
  ) {
    throw new AuthError("invalid_token", "Access token payload is missing required claims", 401);
  }

  const session = await getRefreshSessionById(payload.sid);
  if (!session || session.revokedAt || isExpired(session.refreshExpiresAt)) {
    throw new AuthError("invalid_token", "Associated auth session is no longer active", 401);
  }

  await touchRefreshSession(session.id, REFRESH_SESSION_TOUCH_THROTTLE_MS);

  return {
    sub: payload.sub,
    jti: payload.jti,
    sid: payload.sid,
    clientId: payload.client_id,
    scope: payload.scope,
  };
}
