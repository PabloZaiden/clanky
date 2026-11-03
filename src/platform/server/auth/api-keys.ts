import type { ApiKeySummary, CreatedApiKeyResponse, CurrentUser } from "../../contracts";
import type { ApiKeyRecord, ClankyAccountStore } from "./store";
import { nowIso, randomToken, sha256, secureEqual, isExpired } from "./crypto";
import { AuthError } from "./types";

export interface ManagedApiKeySummary extends ApiKeySummary {
  kind: "managed";
  managedBy?: string;
}

export interface CreatedManagedApiKeyResponse {
  key: ManagedApiKeySummary;
  token: string;
}

export interface ApiKeyCreationOptions {
  name?: string;
  scopes?: string[];
  prefix?: string;
  expiresAt?: string;
}

export interface ManagedApiKeyCreationOptions extends ApiKeyCreationOptions {
  managedBy?: string;
}

function summarize(record: ApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
  };
}

function summarizeManaged(record: ApiKeyRecord): ManagedApiKeySummary {
  return {
    ...summarize(record),
    kind: "managed",
    managedBy: record.managedBy,
  };
}

export function listApiKeys(store: ClankyAccountStore, userId: string): ApiKeySummary[] {
  store.deleteExpiredApiKeys?.(nowIso());
  return store.listApiKeys(userId)
    .filter((record) => record.userId === userId && record.kind === "user")
    .filter((record) => !record.expiresAt || !isExpired(record.expiresAt))
    .map(summarize);
}

function createApiKeyRecord(
  user: CurrentUser,
  input: ApiKeyCreationOptions,
  kind: ApiKeyRecord["kind"],
  managedBy?: string,
): { record: ApiKeyRecord; token: string } {
  const prefix = input.prefix ?? "wapp";
  const token = `${prefix}_${randomToken(32)}`;
  const record: ApiKeyRecord = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: input.name?.trim() || "API key",
    prefix,
    tokenHash: sha256(token),
    scopes: input.scopes?.length ? input.scopes : ["*"],
    createdAt: nowIso(),
    expiresAt: input.expiresAt,
    kind,
    managedBy,
  };
  return { record, token };
}

export function createApiKey(store: ClankyAccountStore, user: CurrentUser, input: ApiKeyCreationOptions): CreatedApiKeyResponse {
  const { record, token } = createApiKeyRecord(user, input, "user");
  store.saveApiKey(record);
  return { key: summarize(record), token };
}

export function deleteApiKey(store: ClankyAccountStore, userId: string, id: string): boolean {
  const record = store.listApiKeys(userId).find((candidate) => candidate.id === id && candidate.userId === userId);
  if (!record || record.kind !== "user") {
    return false;
  }
  return store.deleteApiKey(id, userId);
}

export function createManagedApiKey(store: ClankyAccountStore, user: CurrentUser, input: ManagedApiKeyCreationOptions = {}): CreatedManagedApiKeyResponse {
  const { record, token } = createApiKeyRecord(user, input, "managed", input.managedBy);
  store.saveApiKey(record);
  return { key: summarizeManaged(record), token };
}

export function listManagedApiKeys(store: ClankyAccountStore, userId: string, managedBy?: string): ManagedApiKeySummary[] {
  store.deleteExpiredApiKeys?.(nowIso());
  return store.listApiKeys(userId)
    .filter((record) => record.userId === userId && record.kind === "managed")
    .filter((record) => managedBy === undefined || record.managedBy === managedBy)
    .filter((record) => !record.expiresAt || !isExpired(record.expiresAt))
    .map(summarizeManaged);
}

export function revokeManagedApiKey(store: ClankyAccountStore, id: string, userId?: string): boolean {
  const record = store.listApiKeys(userId).find((candidate) =>
    candidate.id === id
    && candidate.kind === "managed"
    && (userId === undefined || candidate.userId === userId)
  );
  if (!record) {
    return false;
  }
  return store.deleteApiKey(id, record.userId);
}

export function authenticateApiKey(store: ClankyAccountStore, token: string): { user: CurrentUser; apiKeyId: string; scopes: string[] } | undefined {
  const tokenHash = sha256(token);
  const record = store.getApiKeyByHash(tokenHash);
  if (!record || !secureEqual(record.tokenHash, tokenHash) || (record.expiresAt && isExpired(record.expiresAt))) {
    if (record?.expiresAt && isExpired(record.expiresAt)) {
      store.deleteApiKey(record.id);
    }
    return undefined;
  }
  const user = store.getUserById(record.userId);
  if (!user || user.disabledAt) {
    return undefined;
  }
  store.touchApiKey(record.id, nowIso());
  return { user: { id: user.id, username: user.username, role: user.role, isOwner: user.role === "owner", isAdmin: user.role === "owner" || user.role === "admin" }, apiKeyId: record.id, scopes: record.scopes };
}

export function assertScopes(actual: string[], required: string[]): void {
  if (actual.includes("*")) {
    return;
  }
  if (required.length === 0) {
    throw new AuthError("insufficient_scope", "An unrestricted credential is required for this operation", 403);
  }
  for (const scope of required) {
    if (!actual.includes(scope)) {
      throw new AuthError("insufficient_scope", `Missing required scope: ${scope}`, 403);
    }
  }
}
