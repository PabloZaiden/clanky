import { AuthBonusError, createPasswordAuth } from "@pablozaiden/webapp/auth";
import type { ClankyAccountStore, UserRecord } from "./store";
import { AuthError } from "./types";
import { audit, createUserRecord, normalizeUsername } from "./users";
import { nowIso } from "./crypto";

const loginVerifiers = new WeakMap<ClankyAccountStore, Map<string, ReturnType<typeof createPasswordAuth>>>();

function passwordAuth(store: ClankyAccountStore, origin: string, authorizedUser?: UserRecord) {
  return createPasswordAuth({
    origin,
    getCredential: username => {
      const user = store.getUserByUsername(normalizeUsername(username));
      return user && !user.disabledAt ? store.getPassword(user.id) : undefined;
    },
    getCredentialByIdentity: id => {
      const user = store.getUserById(id);
      return user && !user.disabledAt ? store.getPassword(id) : undefined;
    },
    setCredential: (id, expected, next) => Boolean(authorizedUser && id === authorizedUser.id
      && store.setPassword(id, expected, next, authorizedUser.authVersion)),
    allowAttempt: () => true,
  });
}

function loginVerifier(store: ClankyAccountStore, origin: string) {
  let origins = loginVerifiers.get(store);
  if (!origins) {
    origins = new Map();
    loginVerifiers.set(store, origins);
  }
  let verifier = origins.get(origin);
  if (!verifier) {
    verifier = passwordAuth(store, origin);
    origins.set(origin, verifier);
  }
  return verifier;
}

async function passwordResult<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthBonusError) throw new AuthError(error.code, error.message, error.status);
    throw error;
  }
}

function currentPasswordUser(store: ClankyAccountStore, id: string, version: number, authVersion: number): UserRecord {
  const user = store.getUserById(id);
  if (!user || user.disabledAt || user.authVersion !== authVersion || store.getPassword(id)?.version !== version) {
    throw new AuthError("credential_changed", "Credentials changed. Try again.", 409);
  }
  return user;
}

export async function loginWithPassword(req: Request, store: ClankyAccountStore, origin: string, username: string, value: string): Promise<UserRecord> {
  const expectedUser = store.getUserByUsername(normalizeUsername(username));
  const result = await passwordResult(() => loginVerifier(store, origin).verify(req, username, value));
  if (!result || !expectedUser || expectedUser.disabledAt || result.identityId !== expectedUser.id) {
    throw new AuthError("invalid_credentials", "Invalid credentials.", 401);
  }
  const user = currentPasswordUser(store, result.identityId, result.version, expectedUser.authVersion);
  store.markUserLogin(user.id, nowIso());
  audit(store, { eventType: "user_login", actorUserId: user.id });
  return user;
}

export async function enrollPassword(req: Request, store: ClankyAccountStore, origin: string, userId: string, value: string, expectedAuthVersion: number): Promise<UserRecord> {
  const user = store.getUserById(userId);
  if (!user || user.disabledAt || user.authVersion !== expectedAuthVersion) throw new AuthError("authentication_required", "Authentication is required", 401);
  const result = await passwordResult(() => passwordAuth(store, origin, user).enroll(req, user.id, value));
  const updated = currentPasswordUser(store, user.id, result.version, user.authVersion + 1);
  audit(store, { eventType: "password_created", actorUserId: user.id, targetUserId: user.id });
  return updated;
}

export async function changePassword(req: Request, store: ClankyAccountStore, origin: string, userId: string, currentPassword: string, nextPassword: string, expectedAuthVersion: number): Promise<UserRecord> {
  const user = store.getUserById(userId);
  if (!user || user.disabledAt || user.authVersion !== expectedAuthVersion) throw new AuthError("authentication_required", "Authentication is required", 401);
  const result = await passwordResult(() => passwordAuth(store, origin, user).change(req, user.id, currentPassword, nextPassword));
  const updated = currentPasswordUser(store, user.id, result.version, user.authVersion + 1);
  audit(store, { eventType: "password_changed", actorUserId: user.id, targetUserId: user.id });
  return updated;
}

/** The local process authorizes a new identity; only the atomic enrollment callback publishes it. */
export async function initializeOwnerPassword(store: ClankyAccountStore, username: string, value: string): Promise<UserRecord> {
  if (store.countUsers() > 0) throw new AuthError("owner_exists", "Accounts already exist; local setup cannot replace an owner or reset data.", 409);
  const owner = createUserRecord({ username, role: "owner" });
  const origin = "http://localhost";
  const passwords = createPasswordAuth({
    origin,
    getCredential: () => undefined,
    getCredentialByIdentity: () => undefined,
    setCredential: (id, expected, next) => id === owner.id && expected === undefined
      && store.createOwnerWithCredential(owner, { identityId: id, ...next }),
    allowAttempt: () => true,
  });
  await passwordResult(() => passwords.enroll(new Request(`${origin}/`, {
    method: "POST", headers: { origin },
  }), owner.id, value));
  const user = store.getUserById(owner.id)!;
  audit(store, { eventType: "owner_created", targetUserId: user.id });
  return user;
}
