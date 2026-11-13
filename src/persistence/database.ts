/**
 * SQLite database layer for Clanky.
 * Provides centralized database connection and schema management.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm, unlink } from "fs/promises";
import { join } from "path";
import { createLogger, ensurePrivateDirectory, securePrivateFile } from "@pablozaiden/webapp/server";
import { resolveAppDataDir } from "@/platform/server/runtime-config";
import type { ClankyAccountStore } from "@/platform/server/auth/store";
import { createAccountStore } from "./accounts/sqlite-store";
import { assertSchemaBaseline, runMigrations } from "./migrations";
import { createBaseSchema } from "./base-schema";
import { DatabaseNotInitializedError } from "./errors";
import { clearChatMetadataCache } from "./chats/metadata-cache";
import {
  assertSchemaInventory,
  getResettableTableNames,
} from "./schema-inventory";

const log = createLogger("database");

let db: Database | null = null;
let accounts: ClankyAccountStore | undefined;

function currentAccountStore(): ClankyAccountStore {
  if (!accounts) throw new DatabaseNotInitializedError();
  return accounts;
}

// Account services outlive an explicit full reset, while its database does not.
const oauthStore = new Proxy({} as NonNullable<ClankyAccountStore["oauth"]>, {
  get(_target, property) {
    const oauth = currentAccountStore().oauth;
    if (!oauth) throw new Error("OAuth persistence is unavailable");
    return Reflect.get(oauth, property);
  },
});
const accountStore = new Proxy({} as ClankyAccountStore, {
  get(_target, property) {
    return property === "oauth" ? oauthStore : Reflect.get(currentAccountStore(), property);
  },
});

export function getAccountStore(): ClankyAccountStore {
  currentAccountStore();
  return accountStore;
}

export function getDataDir(): string {
  return resolveAppDataDir({
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
  });
}

export function getDatabasePath(): string {
  return join(getDataDir(), "clanky.db");
}

export function getDatabase(): Database {
  if (!db) {
    throw new DatabaseNotInitializedError();
  }
  return db;
}

export async function initializeDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  log.debug("Initializing database", { path: dbPath });

  if (db) {
    if (db.filename === dbPath) {
      log.trace("Database already initialized with same path");
      return;
    }
    clearChatMetadataCache(db);
    db.close();
    db = null;
    accounts = undefined;
  }

  await mkdir(getDataDir(), { recursive: true });
  ensurePrivateDirectory(getDataDir());
  if (existsSync(dbPath)) securePrivateFile(dbPath);

  const nextDatabase = new Database(dbPath);
  db = nextDatabase;

  try {
    securePrivateFile(dbPath);
    nextDatabase.run("PRAGMA busy_timeout = 5000");
    nextDatabase.run("PRAGMA foreign_keys = ON");
    nextDatabase.run("PRAGMA journal_mode = WAL");

    assertSchemaBaseline(nextDatabase);
    createBaseSchema(nextDatabase);
    runMigrations(nextDatabase);
    accounts = createAccountStore(nextDatabase);
    accounts.initialize();
    assertSchemaInventory(nextDatabase);

    log.info("Database initialized", { path: dbPath });
  } catch (error) {
    nextDatabase.close();
    db = null;
    accounts = undefined;
    throw error;
  }
}

export function closeDatabase(): void {
  if (!db) {
    return;
  }
  log.debug("Closing database connection");
  clearChatMetadataCache(db);
  db.close();
  db = null;
  accounts = undefined;
  log.info("Database connection closed");
}

export function isDatabaseReady(): boolean {
  return db !== null;
}

export function resetDatabase(): void {
  if (!db) {
    throw new Error("Database not initialized");
  }

  log.warn("Resetting database - dropping all tables");
  const database = db;
  clearChatMetadataCache(database);

  database.run("PRAGMA foreign_keys = OFF");
  try {
    const dropAllTables = database.transaction(() => {
      for (const tableName of getResettableTableNames()) {
        database.run(`DROP TABLE IF EXISTS ${tableName}`);
      }
    });
    dropAllTables();
  } finally {
    database.run("PRAGMA foreign_keys = ON");
  }

  createBaseSchema(database);
  runMigrations(database);
  getAccountStore().initialize();
  assertSchemaInventory(database);
  log.info("Database reset complete");
}

export async function deleteAndReinitializeDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  log.warn("Deleting database file and reinitializing", { path: dbPath });

  closeDatabase();

  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      await unlink(path);
    } catch {
      // The database or its journal may not exist yet.
    }
  }

  // Retired transport secrets are removed only during an explicit full reset.
  await rm(join(getDataDir(), "ssh-server-keys"), { recursive: true, force: true });
  try {
    await unlink(join(getDataDir(), "workspace-execution-target.key"));
  } catch {
    // The workspace target key may not exist on older installations.
  }

  await initializeDatabase();
  log.info("Database deleted and reinitialized");
}
