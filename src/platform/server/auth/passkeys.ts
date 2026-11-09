import {
  AuthBonusError,
  createPasskeyCeremonies,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@pablozaiden/webapp/auth";
import { isIP } from "node:net";
import type { CurrentUser, PasskeyAuthStatusResponse } from "../../contracts";
import type { RuntimeConfig } from "../runtime-config";
import type { StoredPasskey, UserRecord, ClankyAccountStore } from "./store";
import { hmacSha256, isExpired, nowIso, randomToken, secureEqual, sha256 } from "./crypto";
import { getCookiePath, getRequestOriginInfo } from "@pablozaiden/webapp/server";
import { AuthError } from "./types";
import { assertValidUsername, audit, createUserRecord, toCurrentUser } from "./users";

const SESSION_COOKIE = "webapp_passkey_session";
const CHALLENGE_COOKIE = "webapp_passkey_challenge";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 60 * 10;
const SECRET_KEY = "passkey.secret";

interface SignedCookiePayload {
  expiresAt: number;
}

interface ChallengePayload extends SignedCookiePayload {
  challenge: string;
  type: "bootstrap" | "owner-reset" | "setup" | "authentication";
  userId?: string;
  username?: string;
  setupTokenHash?: string;
  authVersion?: number;
}

interface SessionPayload extends SignedCookiePayload {
  nonce: string;
  userId: string;
  authVersion: number;
  passkeyId?: string;
}

function getSecret(store: ClankyAccountStore): string {
  const existing = store.getPreference(SECRET_KEY);
  if (existing) {
    return existing;
  }
  const secret = randomToken();
  store.setPreference(SECRET_KEY, secret);
  return secret;
}

function encodeSigned(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacSha256(body, secret)}`;
}

function decodeSigned<T>(value: string | undefined, secret: string): T | undefined {
  if (!value) {
    return undefined;
  }
  const [body, signature] = value.split(".", 2);
  if (!body || !signature || !secureEqual(signature, hmacSha256(body, secret))) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const cookie = req.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }
  return undefined;
}

function cookieHeader(req: Request, config: RuntimeConfig, name: string, value: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    `Path=${getCookiePath(req, config)}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function expiredCookie(req: Request, config: RuntimeConfig, name: string, secure: boolean): string {
  return cookieHeader(req, config, name, "", 0, secure);
}

export function createBrowserSessionHeaders(req: Request, store: ClankyAccountStore, config: RuntimeConfig, user: UserRecord, passkeyId?: string): Headers {
  const origin = getRequestOriginInfo(req, config);
  const secret = getSecret(store);
  const payload: SessionPayload = {
    nonce: randomToken(16),
    userId: user.id,
    authVersion: user.authVersion,
    passkeyId,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(req, config, SESSION_COOKIE, encodeSigned(payload, secret), SESSION_TTL_SECONDS, origin.secure));
  headers.append("set-cookie", expiredCookie(req, config, CHALLENGE_COOKIE, origin.secure));
  return headers;
}

function setChallengeHeaders(req: Request, store: ClankyAccountStore, config: RuntimeConfig, payload: Omit<ChallengePayload, "expiresAt">): Headers {
  const origin = getRequestOriginInfo(req, config);
  const secret = getSecret(store);
  const headers = new Headers();
  headers.append("set-cookie", cookieHeader(req, config, CHALLENGE_COOKIE, encodeSigned({
    ...payload,
    expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
  }, secret), CHALLENGE_TTL_SECONDS, origin.secure));
  return headers;
}

function readChallenge(req: Request, store: ClankyAccountStore, type: ChallengePayload["type"]): ChallengePayload {
  const secret = getSecret(store);
  const challenge = decodeSigned<ChallengePayload>(getCookie(req, CHALLENGE_COOKIE), secret);
  if (!challenge || challenge.type !== type || challenge.expiresAt <= Date.now()) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  return challenge;
}

function registrationUserId(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId)) as Uint8Array<ArrayBuffer>;
}

function webauthnRpId(hostname: string): string {
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    throw new AuthError("invalid_passkey_host", "Passkeys require a hostname such as localhost, not an IP address", 400);
  }
  return hostname;
}

function passkeyCeremonies(req: Request, config: RuntimeConfig) {
  const origin = getRequestOriginInfo(req, config);
  return createPasskeyCeremonies({
    origin: origin.origin,
    rpID: webauthnRpId(origin.hostname),
    rpName: config.appName,
    requireUserVerification: false,
  });
}

async function ceremonyResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthBonusError) {
      throw new AuthError(error.code, error.message, error.status);
    }
    throw error;
  }
}

async function beginRegistrationForUser(req: Request, store: ClankyAccountStore, config: RuntimeConfig, user: { id: string; username: string }, type: ChallengePayload["type"], setupTokenHash?: string) {
  const options = await ceremonyResult(() => passkeyCeremonies(req, config).beginRegistration({
    userHandle: registrationUserId(user.id),
    username: user.username,
  }));
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type, userId: user.id, username: user.username, setupTokenHash }) };
}

async function verifyPasskey(req: Request, config: RuntimeConfig, response: RegistrationResponseJSON, user: UserRecord, challenge: ChallengePayload): Promise<StoredPasskey> {
  const info = await ceremonyResult(() => passkeyCeremonies(req, config).verifyRegistration(response, challenge.challenge));
  const timestamp = nowIso();
  return {
    id: crypto.randomUUID(),
    userId: user.id,
    name: "Primary passkey",
    credentialId: info.credential.credentialId,
    publicKey: new Uint8Array(info.credential.publicKey) as Uint8Array<ArrayBuffer>,
    counter: info.credential.counter,
    deviceType: info.deviceType,
    backedUp: info.backedUp,
    transports: info.credential.transports ?? response.response.transports ?? [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function persistPasskey(store: ClankyAccountStore, passkey: StoredPasskey, updatedAt: string, expectedAuthVersion?: number, requireUninitialized = false): UserRecord {
  const result = store.savePasskeyAndIncrementUserAuthVersion(passkey, updatedAt, expectedAuthVersion, requireUninitialized);
  if (result.kind === "saved") {
    return result.user;
  }
  if (result.kind === "credential_conflict") {
    throw new AuthError("registration_failed", "Passkey credential is already registered", 400);
  }
  throw new AuthError("registration_failed", "Passkey registration could not be saved", 400);
}

export function getPasskeySession(req: Request, store: ClankyAccountStore, config: RuntimeConfig): {
  user: CurrentUser;
  passkeyId?: string;
} | undefined {
  if (config.passkeyDisabled) {
    const owner = store.getOwnerUser();
    return owner ? { user: toCurrentUser(owner) } : undefined;
  }
  const secret = store.getPreference(SECRET_KEY);
  if (!secret) {
    return undefined;
  }
  const session = decodeSigned<SessionPayload>(getCookie(req, SESSION_COOKIE), secret);
  if (!session || session.expiresAt <= Date.now()) {
    return undefined;
  }
  const user = store.getUserById(session.userId);
  if (!user || user.disabledAt || user.authVersion !== session.authVersion) {
    return undefined;
  }
  const passkeyId = typeof session.passkeyId === "string"
    ? store.listPasskeys(user.id).find((passkey) => passkey.id === session.passkeyId)?.id
    : undefined;
  return { user: toCurrentUser(user), passkeyId };
}

export function getPasskeySessionUser(req: Request, store: ClankyAccountStore, config: RuntimeConfig) {
  return getPasskeySession(req, store, config)?.user;
}

export function hasPasskeySession(req: Request, store: ClankyAccountStore, config: RuntimeConfig): boolean {
  return Boolean(getPasskeySessionUser(req, store, config));
}

export function isPasskeyAuthRequired(store: ClankyAccountStore, config: RuntimeConfig): boolean {
  return !config.passkeyDisabled && store.countUsers() > 0;
}

export function passkeyStatus(req: Request, store: ClankyAccountStore, config: RuntimeConfig, enabled = true, userId = getPasskeySessionUser(req, store, config)?.id): PasskeyAuthStatusResponse {
  const users = store.countUsers();
  const owner = store.getOwnerUser();
  const passkeyConfigured = store.listPasskeys().length > 0;
  const ownerPasskeySetupRequired = enabled && !config.passkeyDisabled && users > 0 && Boolean(owner && !owner.authInitialized);
  return {
    enabled,
    passkeyConfigured,
    accountPasskeyConfigured: Boolean(userId && store.getPasskeyByUserId(userId)),
    passkeyDisabled: config.passkeyDisabled,
    passkeyRequired: enabled && users > 0 && !config.passkeyDisabled,
    authenticated: !enabled || config.passkeyDisabled || Boolean(getPasskeySessionUser(req, store, config)),
    bootstrapRequired: enabled && !config.passkeyDisabled && users === 0,
    ownerPasskeySetupRequired,
    passkeyAvailable: !isIP(getRequestOriginInfo(req, config).hostname.replace(/^\[|\]$/g, "")),
    passwordEnabled: enabled && !config.passkeyDisabled,
  };
}

export async function beginBootstrapRegistration(req: Request, store: ClankyAccountStore, config: RuntimeConfig, username: string) {
  if (store.countUsers() > 0) {
    throw new AuthError("owner_exists", "Owner user is already configured", 409);
  }
  const normalized = assertValidUsername(username);
  return beginRegistrationForUser(req, store, config, { id: crypto.randomUUID(), username: normalized }, "bootstrap");
}

export async function completeBootstrapRegistration(req: Request, store: ClankyAccountStore, config: RuntimeConfig, response: RegistrationResponseJSON) {
  if (store.countUsers() > 0) {
    throw new AuthError("owner_exists", "Owner user is already configured", 409);
  }
  const challenge = readChallenge(req, store, "bootstrap");
  if (!challenge.userId || !challenge.username) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  const owner = createUserRecord({ username: challenge.username, role: "owner" });
  owner.id = challenge.userId;
  const passkey = await verifyPasskey(req, config, response, owner, challenge);
  if (!store.createOwnerWithCredential(owner, passkey)) {
    throw new AuthError("owner_exists", "Owner user is already configured", 409);
  }
  const updatedUser = store.getUserById(owner.id)!;
  const headers = createBrowserSessionHeaders(req, store, config, updatedUser, passkey.id);
  audit(store, { eventType: "owner_created", targetUserId: owner.id });
  return headers;
}

export async function beginOwnerPasskeySetup(req: Request, store: ClankyAccountStore, config: RuntimeConfig, authorizedOwnerId?: string) {
  const owner = store.getOwnerUser();
  if (!owner || owner.disabledAt || owner.passkeyConfigured || (owner.authInitialized && authorizedOwnerId !== owner.id)) {
    throw new AuthError("owner_setup_unavailable", "Owner passkey setup is not available", 409);
  }
  const options = await ceremonyResult(() => passkeyCeremonies(req, config).beginRegistration({
    userHandle: registrationUserId(owner.id),
    username: owner.username,
  }));
  return { options, headers: setChallengeHeaders(req, store, config, {
    challenge: options.challenge, type: "owner-reset", userId: owner.id, username: owner.username, authVersion: owner.authVersion,
  }) };
}

export async function completeOwnerPasskeySetup(req: Request, store: ClankyAccountStore, config: RuntimeConfig, response: RegistrationResponseJSON, authorizedOwnerId?: string) {
  const challenge = readChallenge(req, store, "owner-reset");
  const owner = challenge.userId ? store.getUserById(challenge.userId) : undefined;
  if (!owner || owner.disabledAt || owner.role !== "owner" || owner.passkeyConfigured || (owner.authInitialized && authorizedOwnerId !== owner.id) || challenge.authVersion !== owner.authVersion) {
    throw new AuthError("owner_setup_unavailable", "Owner passkey setup is not available", 409);
  }
  const passkey = await verifyPasskey(req, config, response, owner, challenge);
  const updatedUser = persistPasskey(store, passkey, passkey.updatedAt, owner.authVersion, authorizedOwnerId !== owner.id);
  const headers = createBrowserSessionHeaders(req, store, config, updatedUser, passkey.id);
  audit(store, { eventType: "owner_passkey_configured", targetUserId: owner.id });
  return headers;
}

export function getSetupDetails(store: ClankyAccountStore, token: string) {
  const link = store.getSetupLinkByTokenHash(sha256(token));
  if (!link || link.consumedAt || isExpired(link.expiresAt)) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const user = store.getUserById(link.userId);
  if (!user) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  return {
    username: user.username,
    role: user.role,
    kind: link.kind === "reset" ? "reset" as const : "invite" as const,
    expiresAt: link.expiresAt,
  };
}

export async function beginSetupRegistration(req: Request, store: ClankyAccountStore, config: RuntimeConfig, token: string) {
  const tokenHash = sha256(token);
  const link = store.getSetupLinkByTokenHash(tokenHash);
  if (!link || link.consumedAt || isExpired(link.expiresAt)) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const user = store.getUserById(link.userId);
  if (!user) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  return beginRegistrationForUser(req, store, config, user, "setup", tokenHash);
}

export async function completeSetupRegistration(req: Request, store: ClankyAccountStore, config: RuntimeConfig, token: string, response: RegistrationResponseJSON) {
  const tokenHash = sha256(token);
  const challenge = readChallenge(req, store, "setup");
  if (challenge.setupTokenHash !== tokenHash || !challenge.userId) {
    throw new AuthError("challenge_invalid", "Passkey challenge is invalid or expired", 400);
  }
  const link = store.getSetupLinkByTokenHash(tokenHash);
  const user = link ? store.getUserById(link.userId) : undefined;
  if (!link || !user || link.consumedAt || isExpired(link.expiresAt) || user.id !== challenge.userId) {
    throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
  }
  const passkey = await verifyPasskey(req, config, response, user, challenge);
  const result = store.completeSetupLink(tokenHash, user.id, passkey, nowIso());
  if (result.kind !== "completed") {
    switch (result.kind) {
      case "not_found":
      case "expired":
      case "consumed":
      case "user_mismatch":
        throw new AuthError("setup_link_invalid", "Setup link is invalid or expired", 404);
      case "conflict":
        throw new AuthError("registration_failed", "Passkey setup could not be completed", 400);
    }
  }
  const headers = createBrowserSessionHeaders(req, store, config, result.user, passkey.id);
  audit(store, { eventType: link.kind === "reset" ? "user_reset_completed" : "user_invite_completed", targetUserId: user.id });
  return headers;
}

export async function beginAuthentication(req: Request, store: ClankyAccountStore, config: RuntimeConfig) {
  const passkeys = store.listPasskeys();
  if (passkeys.length === 0) {
    throw new AuthError("passkey_missing", "No passkey is configured", 409);
  }
  const options = await ceremonyResult(() => passkeyCeremonies(req, config).beginAuthentication(
    passkeys.map(passkey => ({
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports,
    })),
  ));
  return { options, headers: setChallengeHeaders(req, store, config, { challenge: options.challenge, type: "authentication" }) };
}

export async function completeAuthentication(req: Request, store: ClankyAccountStore, config: RuntimeConfig, response: AuthenticationResponseJSON) {
  const challenge = readChallenge(req, store, "authentication");
  const passkey = store.getPasskeyByCredentialId(response.id);
  const user = passkey ? store.getUserById(passkey.userId) : undefined;
  if (!passkey || !user) {
    throw new AuthError("passkey_not_found", "Passkey credential is not registered", 404);
  }
  const verification = await ceremonyResult(() => passkeyCeremonies(req, config).verifyAuthentication(
    response,
    challenge.challenge,
    {
      credentialId: passkey.credentialId,
      publicKey: passkey.publicKey,
      counter: passkey.counter,
      transports: passkey.transports,
    },
  ));
  const timestamp = nowIso();
  store.updatePasskeyUsage(passkey.credentialId, verification.counter, timestamp);
  store.markUserLogin(user.id, timestamp);
  audit(store, { eventType: "user_login", actorUserId: user.id });
  return createBrowserSessionHeaders(req, store, config, user, passkey.id);
}

export function logoutHeaders(req: Request, config: RuntimeConfig): Headers {
  const origin = getRequestOriginInfo(req, config);
  const headers = new Headers();
  headers.append("set-cookie", expiredCookie(req, config, SESSION_COOKIE, origin.secure));
  headers.append("set-cookie", expiredCookie(req, config, CHALLENGE_COOKIE, origin.secure));
  return headers;
}

export function deletePasskey(req: Request, store: ClankyAccountStore, config: RuntimeConfig, userId: string): Headers {
  const timestamp = nowIso();
  store.deletePasskeysForUser(userId);
  store.incrementUserAuthVersion(userId, timestamp);
  store.revokeRefreshSessionsForUser(userId, timestamp);
  audit(store, { eventType: "passkey_deleted", actorUserId: userId, targetUserId: userId });
  return logoutHeaders(req, config);
}
