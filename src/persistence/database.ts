/**
 * SQLite database layer for Clanky Tasks Management System.
 * Provides centralized database connection and schema management.
 */

import { Database } from "bun:sqlite";
import { mkdir, rm, unlink } from "fs/promises";
import { join } from "path";
import { createLogger, resolveAppDataDir } from "@pablozaiden/webapp/server";
import {
  assertBaselineCompatibility,
  runMigrations,
} from "./migrations";
import { createBaseSchema } from "./base-schema";
import { DatabaseNotInitializedError } from "./errors";
import {
  assertSchemaInventory,
  getResettableTableNames,
} from "./schema-inventory";

const log = createLogger("database");

let db: Database | null = null;

export function getDataDir(): string {
  return resolveAppDataDir({
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
  });
}

export function getDatabasePath(): string {
  return join(getDataDir(), "clanky.db");
}

function getSshServerKeyStorePath(): string {
  return join(getDataDir(), "ssh-server-keys");
}

function getWorkspaceExecutionTargetKeyPath(): string {
  return join(getDataDir(), "workspace-execution-target.key");
}

export function getDatabase(): Database {
  if (!db) {
    throw new DatabaseNotInitializedError();
  }
  return db;
}

export async function initializeDatabase(
  options: { meshWorker?: boolean } = {},
): Promise<void> {
  const dbPath = getDatabasePath();
  log.debug("Initializing database", { path: dbPath });

  if (db) {
    if (db.filename === dbPath) {
      log.trace("Database already initialized with same path");
      return;
    }
    db.close();
    db = null;
  }

  await mkdir(getDataDir(), { recursive: true });

  const nextDatabase = new Database(dbPath);
  db = nextDatabase;

  try {
    nextDatabase.run("PRAGMA foreign_keys = ON");
    nextDatabase.run("PRAGMA journal_mode = WAL");
    nextDatabase.run("PRAGMA busy_timeout = 5000");

    assertBaselineCompatibility(nextDatabase, options);
    createBaseSchema(nextDatabase, options);
    runMigrations(nextDatabase, options);
    assertSchemaInventory(nextDatabase);

    log.info("Database initialized", { path: dbPath });
  } catch (error) {
    nextDatabase.close();
    db = null;
    throw error;
  }
}

export function closeDatabase(): void {
  if (!db) {
    return;
  }
  log.debug("Closing database connection");
  db.close();
  db = null;
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

  await rm(getSshServerKeyStorePath(), { recursive: true, force: true });
  try {
    await unlink(getWorkspaceExecutionTargetKeyPath());
  } catch {
    // The workspace target key may not exist on older installations.
  }

  await initializeDatabase();
  log.info("Database deleted and reinitialized");
}
