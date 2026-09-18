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

export async function initializeDatabase(): Promise<void> {
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

    assertBaselineCompatibility(nextDatabase);
    createBaseSchema(nextDatabase);
    runMigrations(nextDatabase);

    log.info("Database initialized", { path: dbPath });
  } catch (error) {
    nextDatabase.close();
    db = null;
    throw error;
  }
}

const RESET_TABLES = [
  "webapp_audit_events",
  "webapp_user_setup_links",
  "webapp_preferences",
  "webapp_refresh_sessions",
  "webapp_device_auth_requests",
  "webapp_api_keys",
  "webapp_passkeys",
  "webapp_signing_keys",
  "webapp_users",
  "mesh_sync_conflicts",
  "mesh_link_claims",
  "mesh_sync_cursors",
  "mesh_sync_outbox",
  "mesh_sync_checkpoints",
  "mesh_pairing_approvals",
  "mesh_pairing_requests",
  "mesh_links",
  "mesh_link_members",
  "mesh_nodes",
  "mesh_enrollment_tokens",
  "mesh_worker_kill_nonces",
  "mesh_worker_registrations",
  "mesh_controller_grants",
  "mesh_controller_relay_pairing",
  "mesh_node_identity",
  "workspace_worker_enrollments",
  "workspace_execution_targets",
  "clanky_context_api_keys",
  "preview_sessions",
  "agent_run_transcript_meta",
  "agent_run_transcript_entries",
  "agent_runs",
  "agents",
  "review_comments",
  "sessions",
  "terminal_sessions",
  "provisioning_job_logs",
  "provisioning_jobs",
  "task_transcript_meta",
  "task_transcript_entries",
  "tasks",
  "chat_transcript_meta",
  "chat_transcript_entries",
  "chats",
  "vnc_sessions",
  "ssh_server_sessions",
  "ssh_servers",
  "workspaces",
  "execution_hosts",
  "preferences",
  "schema_migrations",
] as const;

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
      for (const tableName of RESET_TABLES) {
        database.run(`DROP TABLE IF EXISTS ${tableName}`);
      }
    });
    dropAllTables();
  } finally {
    database.run("PRAGMA foreign_keys = ON");
  }

  createBaseSchema(database);
  runMigrations(database);
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
