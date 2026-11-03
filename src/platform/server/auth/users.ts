import type { CurrentUser, WebAppUserRole, WebAppUserSummary } from "../../contracts";
import type { AuditEventRecord, UserRecord, ClankyAccountStore } from "./store";
import { addSeconds, nowIso, sha256 } from "./crypto";
import { AuthError } from "./types";

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const SETUP_LINK_TTL_SECONDS = 60 * 60 * 24;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function assertValidUsername(username: string): string {
  const normalized = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new AuthError("invalid_username", "Username must be 3-32 lowercase letters, numbers, dots, underscores or hyphens", 400);
  }
  return normalized;
}

export function toCurrentUser(user: UserRecord): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: user.role === "owner",
    isAdmin: user.role === "owner" || user.role === "admin",
  };
}

export function summarizeUser(user: UserRecord): WebAppUserSummary {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    passkeyConfigured: user.passkeyConfigured,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export function createUserRecord(input: { username: string; role: WebAppUserRole }): UserRecord {
  const createdAt = nowIso();
  return {
    id: crypto.randomUUID(),
    username: assertValidUsername(input.username),
    role: input.role,
    authVersion: 1,
    passkeyConfigured: false,
    createdAt,
    updatedAt: createdAt,
  };
}

export function createSetupLinkRecord(input: {
  userId: string;
  token: string;
  kind: "invite" | "reset" | "owner-reset";
  createdByUserId?: string;
}) {
  const createdAt = nowIso();
  return {
    id: crypto.randomUUID(),
    userId: input.userId,
    tokenHash: sha256(input.token),
    kind: input.kind,
    createdByUserId: input.createdByUserId,
    createdAt,
    expiresAt: addSeconds(SETUP_LINK_TTL_SECONDS),
  };
}

export function audit(store: ClankyAccountStore, input: Omit<AuditEventRecord, "id" | "createdAt" | "metadata"> & { metadata?: Record<string, unknown> }): void {
  store.saveAuditEvent({
    id: crypto.randomUUID(),
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    metadata: input.metadata ?? {},
    createdAt: nowIso(),
  });
}
