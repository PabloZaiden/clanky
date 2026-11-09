import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, resolveAppDataDir, securePrivateFile } from "@pablozaiden/webapp/server";
import { assertSchemaBaseline, ensureMigrationsTable } from "../migrations";
import { createAccountStore } from "./sqlite-store";

export interface LocalOwnerAuthStatus {
  ownerExists: boolean;
  authInitialized: boolean;
  passwordConfigured: boolean;
}

export function readLocalOwnerAuthStatus(dataDir = resolveAppDataDir({
  envPrefix: "CLANKY", appDirectoryName: ".clanky",
})): LocalOwnerAuthStatus {
  const empty: LocalOwnerAuthStatus = { ownerExists: false, authInitialized: false, passwordConfigured: false };
  const path = join(dataDir, "clanky.db");
  if (!existsSync(path)) return empty;
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
      if (!tables.has("webapp_users")) return empty;
      const columns = new Set((db.query("PRAGMA table_info(webapp_users)").all() as { name: string }[]).map(row => row.name));
      // Existing accounts will be initialized by the idempotent account migration.
      const initialization = columns.has("auth_initialized") ? "auth_initialized" : "1 AS auth_initialized";
      const owner = db.query(`SELECT id, ${initialization} FROM webapp_users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1`)
        .get() as { id: string; auth_initialized: number } | null;
      if (!owner) return empty;
      return {
        ownerExists: true,
        authInitialized: owner.auth_initialized === 1,
        passwordConfigured: tables.has("webapp_passwords") && Boolean(
          db.query("SELECT 1 FROM webapp_passwords WHERE user_id = ?").get(owner.id),
        ),
      };
    })();
  } finally {
    db.close();
  }
}

export function openLocalAccountStore(dataDir = resolveAppDataDir({
  envPrefix: "CLANKY", appDirectoryName: ".clanky",
})) {
  ensurePrivateDirectory(dataDir);
  const path = join(dataDir, "clanky.db");
  if (!existsSync(path)) {
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  securePrivateFile(path);
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");
    db.transaction(() => {
      assertSchemaBaseline(db);
      ensureMigrationsTable(db);
    }).immediate();
    const store = createAccountStore(db);
    store.initialize();
    return { store, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
