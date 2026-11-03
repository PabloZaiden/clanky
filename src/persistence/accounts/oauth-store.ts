import type { Database } from "bun:sqlite";
import {
  oauthAuthorizationSchema, oauthSessionSchema,
  type OAuthAuthorizationRecord, type OAuthSessionRecord, type OAuthStore,
} from "@/platform/server/auth/oauth-types";

function synchronous<T>(value: T): T {
  if (value && typeof value === "object" && "then" in value) {
    throw new TypeError("OAuth store transactions must be synchronous");
  }
  return value;
}

/** Shares the account database so account checks and credential transitions are atomic. */
export function sqliteOAuthStore(db: Database): OAuthStore {
  function readAuthorization(row: unknown): OAuthAuthorizationRecord | undefined {
    if (!row) return undefined;
    const data = (row as { data: unknown }).data;
    if (typeof data !== "string") throw new Error("Invalid persisted OAuth authorization");
    return oauthAuthorizationSchema.parse(JSON.parse(data) as unknown);
  }
  function readSession(row: unknown): OAuthSessionRecord | undefined {
    if (!row) return undefined;
    const data = (row as { data: unknown }).data;
    if (typeof data !== "string") throw new Error("Invalid persisted OAuth session");
    return oauthSessionSchema.parse(JSON.parse(data) as unknown);
  }
  const store: OAuthStore = {
    initialize() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webapp_oauth_authorizations (
          request_hash TEXT PRIMARY KEY, code_hash TEXT UNIQUE, expires_at REAL NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webapp_oauth_sessions (
          id TEXT PRIMARY KEY, family_id TEXT NOT NULL, user_id TEXT NOT NULL,
          access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT UNIQUE,
          expires_at REAL NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS webapp_oauth_sessions_family ON webapp_oauth_sessions(family_id);
        CREATE INDEX IF NOT EXISTS webapp_oauth_sessions_user ON webapp_oauth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS webapp_oauth_authorizations_expiry ON webapp_oauth_authorizations(expires_at);
        CREATE INDEX IF NOT EXISTS webapp_oauth_sessions_expiry ON webapp_oauth_sessions(expires_at);
      `);
    },
    transaction: operation => db.transaction(() => synchronous(operation())).immediate(),
    getAuthorization: hash => readAuthorization(db.query("SELECT data FROM webapp_oauth_authorizations WHERE request_hash = ?").get(hash)),
    getAuthorizationByCode: hash => readAuthorization(db.query("SELECT data FROM webapp_oauth_authorizations WHERE code_hash = ?").get(hash)),
    saveAuthorization(record) {
      const parsed = oauthAuthorizationSchema.parse(record);
      db.query(`INSERT INTO webapp_oauth_authorizations (request_hash, code_hash, expires_at, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(request_hash) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, data = excluded.data`)
        .run(parsed.requestHash, parsed.codeHash ?? null, parsed.expiresAt, JSON.stringify(parsed));
    },
    getSessionByTokenHash: hash => readSession(db.query("SELECT data FROM webapp_oauth_sessions WHERE access_hash = ? OR refresh_hash = ?").get(hash, hash)),
    saveSession(record) {
      const parsed = oauthSessionSchema.parse(record);
      db.query(`INSERT INTO webapp_oauth_sessions (id, family_id, user_id, access_hash, refresh_hash, expires_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
        .run(parsed.id, parsed.familyId, parsed.userId, parsed.accessHash, parsed.refreshHash ?? null, parsed.expiresAt, JSON.stringify(parsed));
    },
    listSessions: userId => db.query("SELECT data FROM webapp_oauth_sessions WHERE user_id = ?").all(userId).map(row => readSession(row)!),
    revokeFamily(familyId, revokedAt) {
      const records = db.query("SELECT data FROM webapp_oauth_sessions WHERE family_id = ?").all(familyId);
      for (const row of records) {
        const record = readSession(row)!;
        if (record.revokedAt === undefined) store.saveSession({ ...record, revokedAt });
      }
    },
    deleteExpired(now) {
      db.query("DELETE FROM webapp_oauth_authorizations WHERE expires_at <= ?").run(now);
      db.query("DELETE FROM webapp_oauth_sessions WHERE expires_at <= ?").run(now);
    },
  };
  return store;
}
