/**
 * Passkey authentication runtime helpers.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type Base64URLString,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  bumpPasskeyAuthVersion,
  deleteAllPasskeys,
  getOrCreatePasskeyAuthSecret,
  getPasskeyAuthSecret,
  getPasskeyAuthVersion,
  getPasskeyByCredentialId,
  hasRegisteredPasskeys,
  listPasskeys,
  savePasskey,
  updatePasskeyUsage,
  type StoredPasskey,
} from "../persistence/passkey-auth";
import { createLogger } from "./logger";
import { getPublicBasePathFromForwardedPrefix } from "../utils/public-base-path";
import { getRequestOriginInfo } from "../utils/request-origin";

const log = createLogger("core:passkey-auth");

const PASSKEY_RP_NAME = "Ralpher";
const PASSKEY_USER_NAME = "ralpher";
const PASSKEY_USER_DISPLAY_NAME = "Ralpher";
const PASSKEY_USER_ID = new Uint8Array(Buffer.from("ralpher"));
const PASSKEY_SESSION_COOKIE = "ralpher_passkey_session";
const PASSKEY_CHALLENGE_COOKIE = "ralpher_passkey_challenge";
const PASSKEY_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PASSKEY_CHALLENGE_MAX_AGE_SECONDS = 60 * 10;

type PasskeyChallengeType = "registration" | "authentication";

interface PasskeyChallengeCookie {
  challenge: string;
  type: PasskeyChallengeType;
  expiresAt: number;
}

interface PasskeySessionCookie {
  nonce: string;
  version: number;
  expiresAt: number;
}

interface AuthenticatedPasskeySession {
  secret: string;
  sessionCookie: PasskeySessionCookie;
}

export interface PasskeyAuthStatus {
  passkeyConfigured: boolean;
  passkeyDisabled: boolean;
  passkeyRequired: boolean;
  authenticated: boolean;
}

export interface PasskeyFlowResult<TOptions> {
  options: TOptions;
  headers: Headers;
}

export interface PasskeyCompletionResult {
  headers: Headers;
  passkey: StoredPasskey;
}

export class PasskeyAuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PasskeyAuthError";
    this.code = code;
    this.status = status;
  }
}

function isTruthyEnvFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function isPasskeyAuthDisabled(): boolean {
  return isTruthyEnvFlag("RALPHER_DISABLE_PASSKEY");
}

function getCookiePath(req: Request): string {
  return getPublicBasePathFromForwardedPrefix(req.headers.get("x-forwarded-prefix")) || "/";
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signCookieValue(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

function encodeCookiePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCookiePayload<T>(encodedPayload: string): T | undefined {
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T;
  } catch (error) {
    log.warn("Failed to decode signed passkey auth cookie payload", {
      error: String(error),
    });
    return undefined;
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  } = {},
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${String(options.maxAge)}`);
  }
  return parts.join("; ");
}

function clearCookie(name: string, req: Request): string {
  const { secure } = getRequestOriginInfo(req);
  return serializeCookie(name, "", {
    httpOnly: true,
    maxAge: 0,
    path: getCookiePath(req),
    sameSite: "Strict",
    secure,
  });
}

function parseCookies(req: Request): Map<string, string> {
  const rawCookieHeader = req.headers.get("cookie");
  const cookies = new Map<string, string>();
  if (!rawCookieHeader) {
    return cookies;
  }

  const pairs = rawCookieHeader.split(";");
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function readSignedCookie<T>(req: Request, name: string, secret: string): T | undefined {
  const cookies = parseCookies(req);
  const rawValue = cookies.get(name);
  if (!rawValue) {
    return undefined;
  }

  const separatorIndex = rawValue.lastIndexOf(".");
  if (separatorIndex === -1) {
    return undefined;
  }

  const encodedPayload = rawValue.slice(0, separatorIndex);
  const signature = rawValue.slice(separatorIndex + 1);
  if (!encodedPayload || !signature) {
    return undefined;
  }

  const expectedSignature = signCookieValue(encodedPayload, secret);
  if (!secureEquals(signature, expectedSignature)) {
    return undefined;
  }

  return decodeCookiePayload<T>(encodedPayload);
}

function appendSignedCookie(
  headers: Headers,
  req: Request,
  name: string,
  payload: object,
  secret: string,
  maxAge: number,
): void {
  const encodedPayload = encodeCookiePayload(payload);
  const signature = signCookieValue(encodedPayload, secret);
  const { secure } = getRequestOriginInfo(req);
  headers.append(
    "Set-Cookie",
    serializeCookie(name, `${encodedPayload}.${signature}`, {
      httpOnly: true,
      maxAge,
      path: getCookiePath(req),
      sameSite: "Strict",
      secure,
    }),
  );
}

function appendClearedCookie(headers: Headers, req: Request, name: string): void {
  headers.append("Set-Cookie", clearCookie(name, req));
}

function getRemainingSessionMaxAgeSeconds(sessionCookie: PasskeySessionCookie): number {
  return Math.ceil((sessionCookie.expiresAt - Date.now()) / 1000);
}

function getChallengeCookie(
  req: Request,
  secret: string,
  type: PasskeyChallengeType,
): PasskeyChallengeCookie {
  const challengeCookie = readSignedCookie<PasskeyChallengeCookie>(req, PASSKEY_CHALLENGE_COOKIE, secret);
  if (!challengeCookie) {
    throw new PasskeyAuthError("challenge_missing", "No active passkey challenge was found", 400);
  }
  if (challengeCookie.type !== type) {
    throw new PasskeyAuthError("challenge_type_mismatch", "Passkey challenge type does not match the current flow", 400);
  }
  if (challengeCookie.expiresAt <= Date.now()) {
    throw new PasskeyAuthError("challenge_expired", "Passkey challenge has expired", 400);
  }
  return challengeCookie;
}

function createChallengeHeaders(
  req: Request,
  secret: string,
  challenge: string,
  type: PasskeyChallengeType,
): Headers {
  const headers = new Headers();
  appendSignedCookie(headers, req, PASSKEY_CHALLENGE_COOKIE, {
    challenge,
    type,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_MAX_AGE_SECONDS * 1000,
  }, secret, PASSKEY_CHALLENGE_MAX_AGE_SECONDS);
  return headers;
}

async function createSessionHeaders(req: Request): Promise<Headers> {
  const headers = new Headers();
  const secret = await getOrCreatePasskeyAuthSecret();
  const version = await getPasskeyAuthVersion();
  appendSignedCookie(headers, req, PASSKEY_SESSION_COOKIE, {
    nonce: crypto.randomUUID(),
    version,
    expiresAt: Date.now() + PASSKEY_SESSION_MAX_AGE_SECONDS * 1000,
  } satisfies PasskeySessionCookie, secret, PASSKEY_SESSION_MAX_AGE_SECONDS);
  return headers;
}

async function getAuthenticatedPasskeySession(
  req: Request,
): Promise<AuthenticatedPasskeySession | undefined> {
  const secret = await getPasskeyAuthSecret();
  if (!secret) {
    return undefined;
  }

  const sessionCookie = readSignedCookie<PasskeySessionCookie>(req, PASSKEY_SESSION_COOKIE, secret);
  if (!sessionCookie) {
    return undefined;
  }

  if (sessionCookie.expiresAt <= Date.now()) {
    return undefined;
  }

  const currentVersion = await getPasskeyAuthVersion();
  if (sessionCookie.version !== currentVersion) {
    return undefined;
  }

  return {
    secret,
    sessionCookie,
  };
}

export function createPasskeyLogoutHeaders(req: Request): Headers {
  const headers = new Headers();
  appendClearedCookie(headers, req, PASSKEY_SESSION_COOKIE);
  appendClearedCookie(headers, req, PASSKEY_CHALLENGE_COOKIE);
  return headers;
}

export async function isPasskeySessionAuthenticated(req: Request): Promise<boolean> {
  return (await getAuthenticatedPasskeySession(req)) !== undefined;
}

export async function isPasskeyAuthRequired(): Promise<boolean> {
  return !isPasskeyAuthDisabled() && await hasRegisteredPasskeys();
}

export async function isPasskeyRequestAuthorized(req: Request): Promise<boolean> {
  if (!await isPasskeyAuthRequired()) {
    return true;
  }
  return await isPasskeySessionAuthenticated(req);
}

export async function getPasskeyAuthStatus(req?: Request): Promise<PasskeyAuthStatus> {
  const passkeyConfigured = await hasRegisteredPasskeys();
  const passkeyDisabled = isPasskeyAuthDisabled();
  const passkeyRequired = passkeyConfigured && !passkeyDisabled;
  const authenticated = req ? await isPasskeySessionAuthenticated(req) : false;
  return {
    passkeyConfigured,
    passkeyDisabled,
    passkeyRequired,
    authenticated,
  };
}

export async function createPasskeySessionContinuationHeaders(req: Request): Promise<Headers | undefined> {
  const authenticatedSession = await getAuthenticatedPasskeySession(req);
  if (!authenticatedSession) {
    return undefined;
  }

  const maxAge = getRemainingSessionMaxAgeSeconds(authenticatedSession.sessionCookie);
  if (maxAge <= 0) {
    return undefined;
  }

  const headers = new Headers();
  appendSignedCookie(
    headers,
    req,
    PASSKEY_SESSION_COOKIE,
    authenticatedSession.sessionCookie,
    authenticatedSession.secret,
    maxAge,
  );
  return headers;
}

export async function beginPasskeyRegistration(
  req: Request,
): Promise<PasskeyFlowResult<PublicKeyCredentialCreationOptionsJSON>> {
  if (await hasRegisteredPasskeys()) {
    throw new PasskeyAuthError("passkey_exists", "A passkey is already configured. Remove it before registering a new one.", 409);
  }

  const { hostname: rpID } = getRequestOriginInfo(req);
  const secret = await getOrCreatePasskeyAuthSecret();
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID,
    userID: PASSKEY_USER_ID,
    userName: PASSKEY_USER_NAME,
    userDisplayName: PASSKEY_USER_DISPLAY_NAME,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  return {
    options,
    headers: createChallengeHeaders(req, secret, options.challenge, "registration"),
  };
}

export async function completePasskeyRegistration(
  req: Request,
  response: RegistrationResponseJSON,
  name?: string,
): Promise<PasskeyCompletionResult> {
  if (await hasRegisteredPasskeys()) {
    throw new PasskeyAuthError("passkey_exists", "A passkey is already configured. Remove it before registering a new one.", 409);
  }

  const secret = await getOrCreatePasskeyAuthSecret();
  const challengeCookie = getChallengeCookie(req, secret, "registration");
  const { origin, hostname: rpID } = getRequestOriginInfo(req);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeCookie.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    throw new PasskeyAuthError("registration_verification_failed", String(error), 400);
  }

  if (!verification.verified) {
    throw new PasskeyAuthError("registration_failed", "Passkey registration could not be verified", 400);
  }

  const passkeyName = name?.trim() || "Primary passkey";
  const registrationInfo = verification.registrationInfo;
  await savePasskey({
    id: crypto.randomUUID(),
    name: passkeyName,
    credentialId: registrationInfo.credential.id,
    publicKey: registrationInfo.credential.publicKey,
    counter: registrationInfo.credential.counter,
    deviceType: registrationInfo.credentialDeviceType,
    backedUp: registrationInfo.credentialBackedUp,
    transports: registrationInfo.credential.transports,
  });

  await bumpPasskeyAuthVersion();

  const savedPasskey = await getPasskeyByCredentialId(registrationInfo.credential.id);
  if (!savedPasskey) {
    throw new Error("Saved passkey could not be loaded after registration");
  }

  const headers = await createSessionHeaders(req);
  appendClearedCookie(headers, req, PASSKEY_CHALLENGE_COOKIE);

  return {
    headers,
    passkey: savedPasskey,
  };
}

export async function beginPasskeyAuthentication(
  req: Request,
): Promise<PasskeyFlowResult<PublicKeyCredentialRequestOptionsJSON>> {
  const passkeys = await listPasskeys();
  if (passkeys.length === 0) {
    throw new PasskeyAuthError("passkey_missing", "No passkey is configured", 409);
  }

  const { hostname: rpID } = getRequestOriginInfo(req);
  const secret = await getOrCreatePasskeyAuthSecret();
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports,
    })),
    userVerification: "preferred",
  });

  return {
    options,
    headers: createChallengeHeaders(req, secret, options.challenge, "authentication"),
  };
}

export async function completePasskeyAuthentication(
  req: Request,
  response: AuthenticationResponseJSON,
): Promise<PasskeyCompletionResult> {
  const secret = await getOrCreatePasskeyAuthSecret();
  const challengeCookie = getChallengeCookie(req, secret, "authentication");
  const storedPasskey = await getPasskeyByCredentialId(response.id as Base64URLString);
  if (!storedPasskey) {
    throw new PasskeyAuthError("passkey_not_found", "Passkey credential is not registered", 404);
  }

  const { origin, hostname: rpID } = getRequestOriginInfo(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeCookie.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: storedPasskey.credentialId,
        publicKey: new Uint8Array(storedPasskey.publicKey),
        counter: storedPasskey.counter,
        transports: storedPasskey.transports,
      },
      requireUserVerification: true,
    });
  } catch (error) {
    throw new PasskeyAuthError("authentication_verification_failed", String(error), 400);
  }

  if (!verification.verified) {
    throw new PasskeyAuthError("authentication_failed", "Passkey authentication could not be verified", 401);
  }

  await updatePasskeyUsage(
    verification.authenticationInfo.credentialID,
    verification.authenticationInfo.newCounter,
    storedPasskey.transports,
  );

  const updatedPasskey = await getPasskeyByCredentialId(verification.authenticationInfo.credentialID);
  if (!updatedPasskey) {
    throw new Error("Updated passkey could not be loaded after authentication");
  }

  const headers = await createSessionHeaders(req);
  appendClearedCookie(headers, req, PASSKEY_CHALLENGE_COOKIE);

  return {
    headers,
    passkey: updatedPasskey,
  };
}

export async function removeConfiguredPasskeys(req: Request): Promise<Headers> {
  await deleteAllPasskeys();
  await bumpPasskeyAuthVersion();
  return createPasskeyLogoutHeaders(req);
}
