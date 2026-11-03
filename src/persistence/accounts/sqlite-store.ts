import type { Database } from "bun:sqlite";
import type {
  AccountDisableResult,
  ApiKeyRecord,
  AuditEventRecord,
  DeviceAuthExchangeCandidate,
  DeviceAuthApprovalResult,
  DeviceAuthDenialResult,
  DeviceAuthExchangeResult,
  DeviceAuthRequestRecord,
  PasskeyPersistenceResult,
  RefreshSessionRecord,
  RefreshSessionRotationResult,
  SetupLinkCompletionResult,
  StoredPasskey,
  UserRecord,
  UserSetupLinkRecord,
  ClankyAccountStore,
} from "@/platform/server/auth/store";
import type { ApiKeyKind, LogLevelName, ThemePreference, WebAppUserRole } from "@/platform/contracts";
import { createUserRecord } from "@/platform/server/auth/users";
import { sqliteOAuthStore } from "./oauth-store";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createAccountStore(db: Database): ClankyAccountStore {
  const oauth = sqliteOAuthStore(db);

  function immediateTransaction<T>(callback: () => T): T {
    return db.transaction(callback).immediate();
  }

  function tableExists(table: string): boolean {
    const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as Row | null;
    return Boolean(row);
  }

  function tableColumns(table: string): string[] {
    return (db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => text(row["name"]));
  }

  function hasColumn(table: string, column: string): boolean {
    return tableExists(table) && tableColumns(table).includes(column);
  }

  function countRows(table: string, where = ""): number {
    if (!tableExists(table)) {
      return 0;
    }
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}${where}`).get() as Row | null;
    return Number(row?.["count"] ?? 0);
  }

  function createSchema(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webapp_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        auth_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webapp_preferences (
        key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (key, user_id)
      );
      CREATE TABLE IF NOT EXISTS webapp_user_setup_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_user_id TEXT,
        target_user_id TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (actor_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL,
        FOREIGN KEY (target_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS webapp_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        kind TEXT NOT NULL DEFAULT 'user',
        managed_by TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS webapp_device_auth_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (approved_by_user_id) REFERENCES webapp_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS webapp_signing_keys (
        kid TEXT PRIMARY KEY,
        alg TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        private_jwk TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS webapp_refresh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES webapp_users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_webapp_users_username ON webapp_users(username);
      CREATE INDEX IF NOT EXISTS idx_webapp_passkeys_user ON webapp_passkeys(user_id);
      CREATE INDEX IF NOT EXISTS idx_webapp_api_keys_user ON webapp_api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_webapp_refresh_user ON webapp_refresh_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_webapp_audit_created ON webapp_audit_events(created_at);
    `);
  }

  function migrateApiKeySchema(): void {
    if (!tableExists("webapp_api_keys")) {
      return;
    }
    if (!hasColumn("webapp_api_keys", "kind")) {
      db.exec("ALTER TABLE webapp_api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';");
    }
    if (!hasColumn("webapp_api_keys", "managed_by")) {
      db.exec("ALTER TABLE webapp_api_keys ADD COLUMN managed_by TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_webapp_api_keys_managed ON webapp_api_keys(user_id, kind, managed_by);");
  }

  function migrateSigningKeySchema(): void {
    if (!tableExists("webapp_signing_keys")) {
      return;
    }
    immediateTransaction(() => {
      if (!hasColumn("webapp_signing_keys", "active")) {
        db.exec("ALTER TABLE webapp_signing_keys ADD COLUMN active INTEGER NOT NULL DEFAULT 1;");
      }
      db.query("UPDATE webapp_signing_keys SET active = 0").run();
      const winner = db.query(`
        SELECT kid
        FROM webapp_signing_keys
        ORDER BY created_at DESC, rowid ASC
        LIMIT 1
      `).get() as Row | null;
      if (winner) {
        db.query("UPDATE webapp_signing_keys SET active = 1 WHERE kid = ?").run(text(winner["kid"]));
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_webapp_signing_keys_active ON webapp_signing_keys(active) WHERE active = 1;");
    });
  }

  function migrateSingleUserSchema(): void {
    const legacySources = [
      ["webapp_preferences", tableExists("webapp_preferences") && !hasColumn("webapp_preferences", "user_id")],
      ["webapp_passkeys", tableExists("webapp_passkeys") && !hasColumn("webapp_passkeys", "user_id")],
      ["webapp_api_keys", tableExists("webapp_api_keys") && !hasColumn("webapp_api_keys", "user_id")],
      ["webapp_device_auth_requests", tableExists("webapp_device_auth_requests") && !hasColumn("webapp_device_auth_requests", "approved_by_user_id")],
      ["webapp_refresh_sessions", tableExists("webapp_refresh_sessions") && !hasColumn("webapp_refresh_sessions", "user_id")],
    ] as const;
    const legacyTables = legacySources.filter(([, legacy]) => legacy).map(([table]) => table);
    if (legacyTables.length === 0) {
      return;
    }

    const legacyName = (table: string) => `${table}_legacy_single_user`;
    const transaction = db.transaction(() => {
      for (const table of legacyTables) {
        db.exec(`DROP TABLE IF EXISTS ${legacyName(table)};`);
        db.exec(`ALTER TABLE ${table} RENAME TO ${legacyName(table)};`);
      }

      createSchema();

      const legacyPasskeys = legacyName("webapp_passkeys");
      const legacyApiKeys = legacyName("webapp_api_keys");
      const legacyDeviceRequests = legacyName("webapp_device_auth_requests");
      const legacyRefreshSessions = legacyName("webapp_refresh_sessions");
      const hasOwnerData =
        countRows(legacyPasskeys) > 0 ||
        countRows(legacyApiKeys) > 0 ||
        countRows(legacyRefreshSessions) > 0 ||
        countRows(legacyDeviceRequests, " WHERE status IN ('approved', 'consumed')") > 0;
      const owner = hasOwnerData ? createUserRecord({ username: "owner", role: "owner" }) : undefined;
      if (owner) {
        db.query(`
          INSERT INTO webapp_users (id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(owner.id, owner.username, owner.role, owner.authVersion, owner.createdAt, owner.updatedAt, owner.lastLoginAt ?? null, owner.disabledAt ?? null);
      }

      if (tableExists(legacyName("webapp_preferences"))) {
        db.exec(`
          INSERT INTO webapp_preferences (key, user_id, value, updated_at)
          SELECT key, '', value, updated_at FROM ${legacyName("webapp_preferences")}
        `);
        if (owner) {
          db.query(`
            INSERT OR IGNORE INTO webapp_preferences (key, user_id, value, updated_at)
            SELECT key, ?, value, updated_at FROM ${legacyName("webapp_preferences")} WHERE key = 'theme'
          `).run(owner.id);
        }
      }

      if (owner && tableExists(legacyPasskeys)) {
        db.query(`
          INSERT INTO webapp_passkeys
          (id, user_id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at, last_used_at)
          SELECT id, ?, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at, last_used_at
          FROM ${legacyPasskeys}
          ORDER BY created_at ASC
          LIMIT 1
        `).run(owner.id);
      }

      if (owner && tableExists(legacyApiKeys)) {
        db.query(`
          INSERT INTO webapp_api_keys (id, user_id, name, prefix, token_hash, scopes, created_at, last_used_at, expires_at)
          SELECT id, ?, name, prefix, token_hash, scopes, created_at, last_used_at, expires_at FROM ${legacyApiKeys}
        `).run(owner.id);
      }

      if (tableExists(legacyDeviceRequests)) {
        db.query(`
          INSERT INTO webapp_device_auth_requests
          (device_code_hash, user_code, client_id, scope, status, approved_by_user_id, created_at, updated_at, expires_at)
          SELECT device_code_hash, user_code, client_id, scope, status,
            CASE WHEN status IN ('approved', 'consumed') THEN ? ELSE NULL END,
            created_at, updated_at, expires_at
          FROM ${legacyDeviceRequests}
        `).run(owner?.id ?? null);
      }

      if (owner && tableExists(legacyRefreshSessions)) {
        db.query(`
          INSERT INTO webapp_refresh_sessions
          (id, user_id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
          SELECT id, ?, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at
          FROM ${legacyRefreshSessions}
        `).run(owner.id);
      }

      for (const table of legacyTables) {
        db.exec(`DROP TABLE IF EXISTS ${legacyName(table)};`);
      }
    });

    db.exec("PRAGMA foreign_keys = OFF;");
    transaction();
  }

  function initialize(): void {
    migrateSingleUserSchema();
    createSchema();
    migrateApiKeySchema();
    migrateSigningKeySchema();
    oauth.initialize();
    db.exec("PRAGMA foreign_keys = ON;");
  }

  function getPreference(key: string, userId?: string): string | undefined {
    const row = db.query("SELECT value FROM webapp_preferences WHERE key = ? AND user_id = ?").get(key, userId ?? "") as Row | null;
    return optionalText(row?.["value"]);
  }

  function setPreference(key: string, value: string, userId?: string): void {
    db.query(`
      INSERT INTO webapp_preferences (key, user_id, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, userId ?? "", value, nowIso());
  }

  function deletePreference(key: string, userId?: string): void {
    if (userId) {
      db.query("DELETE FROM webapp_preferences WHERE key = ? AND user_id = ?").run(key, userId);
      return;
    }
    db.query("DELETE FROM webapp_preferences WHERE key = ? AND user_id = ''").run(key);
  }

  function mapUser(row: Row): UserRecord {
    return {
      id: text(row["id"]),
      username: text(row["username"]),
      role: text(row["role"]) as WebAppUserRole,
      authVersion: Number(row["auth_version"] ?? 0),
      passkeyConfigured: Number(row["passkey_configured"] ?? 0) > 0,
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      lastLoginAt: optionalText(row["last_login_at"]),
      disabledAt: optionalText(row["disabled_at"]),
    };
  }

  function mapSetupLink(row: Row): UserSetupLinkRecord {
    return {
      id: text(row["id"]),
      userId: text(row["user_id"]),
      tokenHash: text(row["token_hash"]),
      kind: text(row["kind"]) as UserSetupLinkRecord["kind"],
      createdByUserId: optionalText(row["created_by_user_id"]),
      createdAt: text(row["created_at"]),
      expiresAt: text(row["expires_at"]),
      consumedAt: optionalText(row["consumed_at"]),
    };
  }

  function mapAudit(row: Row): AuditEventRecord {
    return {
      id: text(row["id"]),
      eventType: text(row["event_type"]),
      actorUserId: optionalText(row["actor_user_id"]),
      targetUserId: optionalText(row["target_user_id"]),
      metadata: json<Record<string, unknown>>(row["metadata"], {}),
      createdAt: text(row["created_at"]),
    };
  }

  function mapPasskey(row: Row): StoredPasskey {
    return {
      id: text(row["id"]),
      userId: text(row["user_id"]),
      name: text(row["name"]),
      credentialId: text(row["credential_id"]),
      publicKey: new Uint8Array(row["public_key"] as ArrayBuffer) as Uint8Array<ArrayBuffer>,
      counter: Number(row["counter"] ?? 0),
      deviceType: text(row["device_type"]),
      backedUp: Number(row["backed_up"] ?? 0) === 1,
      transports: json<string[]>(row["transports"], []),
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
    };
  }

  function mapApiKey(row: Row): ApiKeyRecord {
    const kind: ApiKeyKind = row["kind"] === "managed" ? "managed" : "user";
    return {
      id: text(row["id"]),
      userId: text(row["user_id"]),
      name: text(row["name"]),
      prefix: text(row["prefix"]),
      tokenHash: text(row["token_hash"]),
      scopes: json<string[]>(row["scopes"], []),
      createdAt: text(row["created_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
      expiresAt: optionalText(row["expires_at"]),
      kind,
      managedBy: optionalText(row["managed_by"]),
    };
  }

  function mapDevice(row: Row): DeviceAuthRequestRecord {
    return {
      deviceCodeHash: text(row["device_code_hash"]),
      userCode: text(row["user_code"]),
      clientId: text(row["client_id"]),
      scope: text(row["scope"]),
      status: text(row["status"]) as DeviceAuthRequestRecord["status"],
      approvedByUserId: optionalText(row["approved_by_user_id"]),
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      expiresAt: text(row["expires_at"]),
    };
  }

  function mapRefresh(row: Row): RefreshSessionRecord {
    return {
      id: text(row["id"]),
      userId: text(row["user_id"]),
      familyId: text(row["family_id"]),
      clientId: text(row["client_id"]),
      scope: text(row["scope"]),
      refreshTokenHash: text(row["refresh_token_hash"]),
      createdAt: text(row["created_at"]),
      updatedAt: text(row["updated_at"]),
      expiresAt: text(row["expires_at"]),
      lastUsedAt: optionalText(row["last_used_at"]),
      revokedAt: optionalText(row["revoked_at"]),
    };
  }

  function mapSigningKey(row: Row) {
    return {
      alg: text(row["alg"]),
      kid: text(row["kid"]),
      publicJwk: json<Record<string, unknown>>(row["public_jwk"], {}),
      privateJwk: json<Record<string, unknown>>(row["private_jwk"], {}),
      createdAt: text(row["created_at"]),
    };
  }

  function userSelect(): string {
    return `
      SELECT u.*,
        CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS passkey_configured
      FROM webapp_users u
      LEFT JOIN webapp_passkeys p ON p.user_id = u.id
    `;
  }

  function readUserById(id: string): UserRecord | undefined {
    const row = db.query(`${userSelect()} WHERE u.id = ?`).get(id) as Row | null;
    return row ? mapUser(row) : undefined;
  }

  function savePasskeyRecord(passkey: StoredPasskey): void {
    db.query(`
      INSERT INTO webapp_passkeys
      (id, user_id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        id = excluded.id,
        name = excluded.name,
        credential_id = excluded.credential_id,
        public_key = excluded.public_key,
        counter = excluded.counter,
        device_type = excluded.device_type,
        backed_up = excluded.backed_up,
        transports = excluded.transports,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at
    `).run(
      passkey.id,
      passkey.userId,
      passkey.name,
      passkey.credentialId,
      passkey.publicKey,
      passkey.counter,
      passkey.deviceType,
      passkey.backedUp ? 1 : 0,
      JSON.stringify(passkey.transports),
      passkey.createdAt,
      passkey.updatedAt,
      passkey.lastUsedAt ?? null,
    );
  }

  function passkeyCredentialOwner(credentialId: string): string | undefined {
    const row = db.query("SELECT user_id FROM webapp_passkeys WHERE credential_id = ?").get(credentialId) as Row | null;
    return optionalText(row?.["user_id"]);
  }

  function savePasskeyAndIncrementUserAuthVersion(passkey: StoredPasskey, updatedAt: string): PasskeyPersistenceResult {
    return immediateTransaction(() => {
      if (!readUserById(passkey.userId)) {
        return { kind: "missing_user" };
      }
      const credentialOwner = passkeyCredentialOwner(passkey.credentialId);
      if (credentialOwner && credentialOwner !== passkey.userId) {
        return { kind: "credential_conflict" };
      }
      savePasskeyRecord(passkey);
      const result = db.query("UPDATE webapp_users SET auth_version = auth_version + 1, updated_at = ? WHERE id = ?")
        .run(updatedAt, passkey.userId);
      if (result.changes === 0) {
        return { kind: "conflict" };
      }
      const user = readUserById(passkey.userId);
      return user ? { kind: "saved", user } : { kind: "conflict" };
    });
  }

  function completeSetupLink(
    tokenHash: string,
    userId: string,
    passkey: StoredPasskey,
    completedAt: string,
  ): SetupLinkCompletionResult {
    return immediateTransaction(() => {
      const linkRow = db.query("SELECT * FROM webapp_user_setup_links WHERE token_hash = ?").get(tokenHash) as Row | null;
      if (!linkRow) {
        return { kind: "not_found" };
      }
      const link = mapSetupLink(linkRow);
      if (link.consumedAt) {
        return { kind: "consumed" };
      }
      if (link.expiresAt <= completedAt) {
        return { kind: "expired" };
      }
      if (link.userId !== userId || passkey.userId !== link.userId) {
        return { kind: "user_mismatch" };
      }
      if (!readUserById(link.userId)) {
        return { kind: "not_found" };
      }
      const credentialOwner = passkeyCredentialOwner(passkey.credentialId);
      if (credentialOwner && credentialOwner !== passkey.userId) {
        return { kind: "conflict" };
      }
      const claimed = db.query(`
        UPDATE webapp_user_setup_links
        SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(completedAt, tokenHash, completedAt);
      if (claimed.changes === 0) {
        const current = db.query("SELECT * FROM webapp_user_setup_links WHERE token_hash = ?").get(tokenHash) as Row | null;
        if (!current) {
          return { kind: "not_found" };
        }
        const currentLink = mapSetupLink(current);
        return currentLink.consumedAt
          ? { kind: "consumed" }
          : currentLink.expiresAt <= completedAt
            ? { kind: "expired" }
            : { kind: "conflict" };
      }
      savePasskeyRecord(passkey);
      const authVersionUpdate = db.query("UPDATE webapp_users SET auth_version = auth_version + 1, updated_at = ? WHERE id = ?")
        .run(completedAt, link.userId);
      if (authVersionUpdate.changes === 0) {
        return { kind: "conflict" };
      }
      const user = readUserById(link.userId);
      if (!user) {
        return { kind: "conflict" };
      }
      return {
        kind: "completed",
        link: { ...link, consumedAt: completedAt },
        user,
      };
    });
  }

  function approveDeviceAuth(userCode: string, userId: string, updatedAt: string): DeviceAuthApprovalResult {
    return immediateTransaction(() => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE user_code = ?").get(userCode) as Row | null;
      if (!row) {
        return { kind: "not_found" };
      }
      const record = mapDevice(row);
      if (record.expiresAt <= updatedAt) {
        return { kind: "expired" };
      }
      if (record.status === "approved") {
        return record.approvedByUserId === userId
          ? { kind: "already_approved", record }
          : { kind: "conflict" };
      }
      if (record.status !== "pending") {
        return { kind: record.status };
      }
      const result = db.query(`
        UPDATE webapp_device_auth_requests
        SET status = 'approved', approved_by_user_id = ?, updated_at = ?
        WHERE user_code = ? AND status = 'pending' AND expires_at > ?
      `).run(userId, updatedAt, userCode, updatedAt);
      if (result.changes === 0) {
        return { kind: "conflict" };
      }
      return {
        kind: "approved",
        record: { ...record, status: "approved", approvedByUserId: userId, updatedAt },
      };
    });
  }

  function denyDeviceAuth(userCode: string, updatedAt: string): DeviceAuthDenialResult {
    return immediateTransaction(() => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE user_code = ?").get(userCode) as Row | null;
      if (!row) {
        return { kind: "not_found" };
      }
      const record = mapDevice(row);
      if (record.expiresAt <= updatedAt) {
        return { kind: "expired" };
      }
      if (record.status === "denied") {
        return { kind: "already_denied", record };
      }
      if (record.status !== "pending") {
        return { kind: record.status };
      }
      const result = db.query(`
        UPDATE webapp_device_auth_requests
        SET status = 'denied', updated_at = ?
        WHERE user_code = ? AND status = 'pending' AND expires_at > ?
      `).run(updatedAt, userCode, updatedAt);
      if (result.changes === 0) {
        return { kind: "conflict" };
      }
      return { kind: "denied", record: { ...record, status: "denied", updatedAt } };
    });
  }

  function exchangeDeviceAuth(
    deviceCodeHash: string,
    clientId: string | undefined,
    next: DeviceAuthExchangeCandidate,
    now: string,
  ): DeviceAuthExchangeResult {
    return immediateTransaction(() => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE device_code_hash = ?").get(deviceCodeHash) as Row | null;
      if (!row) {
        return { kind: "not_found" };
      }
      const record = mapDevice(row);
      if (record.expiresAt <= now) {
        return { kind: "expired" };
      }
      if (clientId && record.clientId !== clientId) {
        return { kind: "client_mismatch" };
      }
      if (record.status !== "approved") {
        return { kind: record.status === "pending" ? "pending" : record.status };
      }
      if (!record.approvedByUserId) {
        return { kind: "conflict" };
      }
      const user = readUserById(record.approvedByUserId);
      if (!user) {
        return { kind: "missing_user" };
      }
      if (user.disabledAt) {
        return { kind: "disabled_user" };
      }
      if ((next.userId && next.userId !== user.id) || next.clientId !== record.clientId || next.scope !== record.scope) {
        return { kind: "conflict" };
      }
      const session: RefreshSessionRecord = { ...next, userId: user.id };
      const claimed = db.query(`
        UPDATE webapp_device_auth_requests
        SET status = 'consumed', updated_at = ?
        WHERE device_code_hash = ? AND status = 'approved' AND expires_at > ?
      `).run(now, deviceCodeHash, now);
      if (claimed.changes === 0) {
        return { kind: "conflict" };
      }
      db.query(`
        UPDATE webapp_refresh_sessions
        SET revoked_at = ?, updated_at = ?
        WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?
      `).run(now, now, user.id, record.clientId, now);
      db.query(`
        INSERT INTO webapp_refresh_sessions
        (id, user_id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, session.userId, session.familyId, session.clientId, session.scope, session.refreshTokenHash, session.createdAt, session.updatedAt, session.expiresAt, session.lastUsedAt ?? null, session.revokedAt ?? null);
      return {
        kind: "exchanged",
        request: { ...record, status: "consumed", updatedAt: now },
        user,
        session,
      };
    });
  }

  function rotateRefreshSession(
    oldHash: string,
    next: RefreshSessionRecord,
    now: string,
    clientId?: string,
  ): RefreshSessionRotationResult {
    return immediateTransaction(() => {
      const row = db.query("SELECT * FROM webapp_refresh_sessions WHERE refresh_token_hash = ?").get(oldHash) as Row | null;
      if (!row) {
        return { kind: "not_found" };
      }
      const previous = mapRefresh(row);
      if (previous.revokedAt) {
        db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL")
          .run(now, now, previous.familyId);
        return { kind: "replayed", familyId: previous.familyId, userId: previous.userId };
      }
      if (previous.expiresAt <= now) {
        return { kind: "expired" };
      }
      if (clientId && previous.clientId !== clientId) {
        return { kind: "client_mismatch" };
      }
      const user = readUserById(previous.userId);
      if (!user) {
        db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL")
          .run(now, now, previous.familyId);
        return { kind: "missing_user", familyId: previous.familyId, userId: previous.userId };
      }
      if (user.disabledAt) {
        db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL")
          .run(now, now, previous.familyId);
        return { kind: "disabled_user", familyId: previous.familyId, userId: previous.userId };
      }
      if (next.userId !== previous.userId || next.familyId !== previous.familyId || next.clientId !== previous.clientId || next.scope !== previous.scope) {
        return { kind: "conflict" };
      }
      const conflicting = db.query(`
        SELECT 1
        FROM webapp_refresh_sessions
        WHERE id = ? OR refresh_token_hash = ?
        LIMIT 1
      `).get(next.id, next.refreshTokenHash) as Row | null;
      if (conflicting) {
        return { kind: "conflict" };
      }
      const revoked = db.query(`
        UPDATE webapp_refresh_sessions
        SET revoked_at = ?, updated_at = ?
        WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?
      `).run(now, now, oldHash, now);
      if (revoked.changes === 0) {
        return { kind: "conflict" };
      }
      db.query(`
        INSERT INTO webapp_refresh_sessions
        (id, user_id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(next.id, next.userId, next.familyId, next.clientId, next.scope, next.refreshTokenHash, next.createdAt, next.updatedAt, next.expiresAt, next.lastUsedAt ?? null, next.revokedAt ?? null);
      return { kind: "rotated", previous, session: next, user };
    });
  }

  function disableUser(id: string, disabledAt: string): AccountDisableResult {
    return immediateTransaction(() => {
      const existing = readUserById(id);
      if (!existing) {
        return { kind: "not_found" };
      }
      if (existing.role === "owner") {
        return { kind: "owner_immutable" };
      }
      if (existing.disabledAt) {
        return { kind: "already_disabled", user: existing };
      }
      const result = db.query(`
        UPDATE webapp_users
        SET disabled_at = ?, auth_version = auth_version + 1, updated_at = ?
        WHERE id = ? AND disabled_at IS NULL AND role != 'owner'
      `).run(disabledAt, disabledAt, id);
      if (result.changes === 0) {
        return { kind: "conflict" };
      }
      db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(disabledAt, disabledAt, id);
      const user = readUserById(id);
      return user ? { kind: "disabled", user } : { kind: "conflict" };
    });
  }

  return {
    oauth,
    initialize,
    getPreference,
    setPreference,
    deletePreference,
    getThemePreference: (userId) => getPreference("theme", userId) as ThemePreference | undefined,
    setThemePreference: (value, userId) => setPreference("theme", value, userId),
    getLogLevelPreference: () => getPreference("logLevel") as LogLevelName | undefined,
    setLogLevelPreference: (value) => setPreference("logLevel", value),
    getServerLogsEnabledPreference: () => {
      const value = getPreference("serverLogsEnabled");
      return value === "true" ? true : value === "false" ? false : undefined;
    },
    setServerLogsEnabledPreference: (value) => setPreference("serverLogsEnabled", String(value)),

    countUsers: () => Number((db.query("SELECT COUNT(*) AS count FROM webapp_users").get() as Row | null)?.["count"] ?? 0),
    listUsers: () => (db.query(`${userSelect()} ORDER BY u.created_at ASC`).all() as Row[]).map(mapUser),
    createUser: (user) => {
      db.query(`
        INSERT INTO webapp_users (id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, user.username, user.role, user.authVersion, user.createdAt, user.updatedAt, user.lastLoginAt ?? null, user.disabledAt ?? null);
    },
    getUserById: readUserById,
    getUserByUsername: (username) => {
      const row = db.query(`${userSelect()} WHERE lower(u.username) = lower(?)`).get(username) as Row | null;
      return row ? mapUser(row) : undefined;
    },
    getOwnerUser: () => {
      const row = db.query(`${userSelect()} WHERE u.role = 'owner' ORDER BY u.created_at ASC LIMIT 1`).get() as Row | null;
      return row ? mapUser(row) : undefined;
    },
    setUserRole: (id, role, updatedAt) => {
      const result = db.query("UPDATE webapp_users SET role = ?, updated_at = ? WHERE id = ?").run(role, updatedAt, id);
      return result.changes > 0;
    },
    markUserLogin: (id, lastLoginAt) => {
      db.query("UPDATE webapp_users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(lastLoginAt, lastLoginAt, id);
    },
    incrementUserAuthVersion: (id, updatedAt) => {
      db.query("UPDATE webapp_users SET auth_version = auth_version + 1, updated_at = ? WHERE id = ?").run(updatedAt, id);
    },
    deleteUser: (id) => {
      const result = db.query("DELETE FROM webapp_users WHERE id = ? AND role != 'owner'").run(id);
      return result.changes > 0;
    },

    createSetupLink: (record) => {
      db.query(`
        INSERT INTO webapp_user_setup_links
        (id, user_id, token_hash, kind, created_by_user_id, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.userId, record.tokenHash, record.kind, record.createdByUserId ?? null, record.createdAt, record.expiresAt, record.consumedAt ?? null);
    },
    getSetupLinkByTokenHash: (tokenHash) => {
      const row = db.query("SELECT * FROM webapp_user_setup_links WHERE token_hash = ?").get(tokenHash) as Row | null;
      return row ? mapSetupLink(row) : undefined;
    },
    completeSetupLink,
    deletePendingSetupLinksForUser: (userId, now) => {
      db.query("UPDATE webapp_user_setup_links SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(now, userId);
    },

    saveAuditEvent: (record) => {
      db.query(`
        INSERT INTO webapp_audit_events (id, event_type, actor_user_id, target_user_id, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.id, record.eventType, record.actorUserId ?? null, record.targetUserId ?? null, JSON.stringify(record.metadata), record.createdAt);
    },
    listAuditEvents: (limit = 100) => (db.query("SELECT * FROM webapp_audit_events ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(mapAudit),

    listPasskeys: (userId) => {
      const rows = userId
        ? (db.query("SELECT * FROM webapp_passkeys WHERE user_id = ? ORDER BY created_at ASC").all(userId) as Row[])
        : (db.query("SELECT * FROM webapp_passkeys ORDER BY created_at ASC").all() as Row[]);
      return rows.map(mapPasskey);
    },
    getPasskeyByUserId: (userId) => {
      const row = db.query("SELECT * FROM webapp_passkeys WHERE user_id = ?").get(userId) as Row | null;
      return row ? mapPasskey(row) : undefined;
    },
    getPasskeyByCredentialId: (credentialId) => {
      const row = db.query("SELECT * FROM webapp_passkeys WHERE credential_id = ?").get(credentialId) as Row | null;
      return row ? mapPasskey(row) : undefined;
    },
    savePasskey: savePasskeyRecord,
    savePasskeyAndIncrementUserAuthVersion,
    updatePasskeyUsage: (credentialId, counter, lastUsedAt) => {
      db.query("UPDATE webapp_passkeys SET counter = ?, last_used_at = ?, updated_at = ? WHERE credential_id = ?")
        .run(counter, lastUsedAt, lastUsedAt, credentialId);
    },
    deletePasskeysForUser: (userId) => {
      db.query("DELETE FROM webapp_passkeys WHERE user_id = ?").run(userId);
    },

    listApiKeys: (userId) => {
      // Date values have millisecond precision; use insertion order for ties.
      const rows = userId
        ? (db.query("SELECT * FROM webapp_api_keys WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId) as Row[])
        : (db.query("SELECT * FROM webapp_api_keys ORDER BY created_at DESC, rowid DESC").all() as Row[]);
      return rows.map(mapApiKey);
    },
    getApiKeyByHash: (tokenHash) => {
      const row = db.query("SELECT * FROM webapp_api_keys WHERE token_hash = ?").get(tokenHash) as Row | null;
      return row ? mapApiKey(row) : undefined;
    },
    saveApiKey: (record) => {
      db.query(`
        INSERT INTO webapp_api_keys
        (id, user_id, name, prefix, token_hash, scopes, created_at, last_used_at, expires_at, kind, managed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.userId,
        record.name,
        record.prefix,
        record.tokenHash,
        JSON.stringify(record.scopes),
        record.createdAt,
        record.lastUsedAt ?? null,
        record.expiresAt ?? null,
        record.kind,
        record.managedBy ?? null,
      );
    },
    touchApiKey: (id, lastUsedAt) => {
      db.query("UPDATE webapp_api_keys SET last_used_at = ? WHERE id = ?").run(lastUsedAt, id);
    },
    deleteApiKey: (id, userId) => {
      const result = userId
        ? db.query("DELETE FROM webapp_api_keys WHERE id = ? AND user_id = ?").run(id, userId)
        : db.query("DELETE FROM webapp_api_keys WHERE id = ?").run(id);
      return result.changes > 0;
    },
    deleteApiKeysForUser: (userId) => {
      db.query("DELETE FROM webapp_api_keys WHERE user_id = ?").run(userId);
    },
    deleteExpiredApiKeys: (now) => {
      db.query("DELETE FROM webapp_api_keys WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    },

    saveDeviceAuthRequest: (record) => {
      db.query(`
        INSERT INTO webapp_device_auth_requests
        (device_code_hash, user_code, client_id, scope, status, approved_by_user_id, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.deviceCodeHash, record.userCode, record.clientId, record.scope, record.status, record.approvedByUserId ?? null, record.createdAt, record.updatedAt, record.expiresAt);
    },
    getDeviceAuthByUserCode: (userCode) => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE user_code = ?").get(userCode) as Row | null;
      return row ? mapDevice(row) : undefined;
    },
    getDeviceAuthByDeviceCodeHash: (deviceCodeHash) => {
      const row = db.query("SELECT * FROM webapp_device_auth_requests WHERE device_code_hash = ?").get(deviceCodeHash) as Row | null;
      return row ? mapDevice(row) : undefined;
    },
    approveDeviceAuth,
    denyDeviceAuth,
    exchangeDeviceAuth,
    deleteExpiredDeviceAuthRequests: (now) => {
      db.query("DELETE FROM webapp_device_auth_requests WHERE expires_at <= ?").run(now);
    },

    getSigningKey: () => {
      const row = db.query("SELECT * FROM webapp_signing_keys WHERE active = 1 ORDER BY created_at DESC, rowid ASC LIMIT 1").get() as Row | null;
      return row ? mapSigningKey(row) : undefined;
    },
    getOrCreateSigningKey: (candidate) => immediateTransaction(() => {
      const existing = db.query("SELECT * FROM webapp_signing_keys WHERE active = 1 ORDER BY created_at DESC, rowid ASC LIMIT 1").get() as Row | null;
      if (existing) {
        return mapSigningKey(existing);
      }
      db.query(`
        INSERT INTO webapp_signing_keys (kid, alg, public_jwk, private_jwk, created_at, active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT DO NOTHING
      `).run(candidate.kid, candidate.alg, JSON.stringify(candidate.publicJwk), JSON.stringify(candidate.privateJwk), candidate.createdAt);
      const winner = db.query("SELECT * FROM webapp_signing_keys WHERE active = 1 ORDER BY created_at DESC, rowid ASC LIMIT 1").get() as Row | null;
      if (!winner) {
        throw new Error("Signing-key initialization did not produce an active key");
      }
      return mapSigningKey(winner);
    }),

    saveRefreshSession: (record) => {
      db.query(`
        INSERT INTO webapp_refresh_sessions
        (id, user_id, family_id, client_id, scope, refresh_token_hash, created_at, updated_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.userId, record.familyId, record.clientId, record.scope, record.refreshTokenHash, record.createdAt, record.updatedAt, record.expiresAt, record.lastUsedAt ?? null, record.revokedAt ?? null);
    },
    getRefreshSession: (id, userId) => {
      const row = db.query("SELECT * FROM webapp_refresh_sessions WHERE id = ? AND user_id = ?").get(id, userId) as Row | null;
      return row ? mapRefresh(row) : undefined;
    },
    getRefreshSessionByHash: (refreshTokenHash) => {
      const row = db.query("SELECT * FROM webapp_refresh_sessions WHERE refresh_token_hash = ?").get(refreshTokenHash) as Row | null;
      return row ? mapRefresh(row) : undefined;
    },
    listRefreshSessions: (userId) => {
      const rows = userId
        ? (db.query("SELECT * FROM webapp_refresh_sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Row[])
        : (db.query("SELECT * FROM webapp_refresh_sessions ORDER BY created_at DESC").all() as Row[]);
      return rows.map(mapRefresh);
    },
    rotateRefreshSession,
    revokeRefreshSession: (id, revokedAt, userId) => {
      const result = userId
        ? db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, id, userId)
        : db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, id);
      return result.changes > 0;
    },
    revokeRefreshFamily: (familyId, revokedAt) => {
      db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE family_id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, familyId);
    },
    revokeRefreshSessionsForUser: (userId, revokedAt) => {
      db.query("UPDATE webapp_refresh_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(revokedAt, revokedAt, userId);
    },
    deleteExpiredRefreshSessions: (now) => {
      db.query("DELETE FROM webapp_refresh_sessions WHERE expires_at <= ?").run(now);
    },
    disableUser,
  };
}
