/**
 * Materialize the current-schema demo UI seed into a runtime data directory
 * and, unless disabled, apply it to the SQLite database.
 *
 * Usage:
 *   bun tests/test-data-generation/generate-demo-ui-data.ts
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --skip-apply
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --data-dir ./tmp/demo-data
 *
 * The SQL seed is kept in the current schema. This script intentionally does
 * not rewrite legacy columns or transcript payloads at runtime.
 */

import { mkdir } from "fs/promises";
import { join, resolve } from "path";

interface DatabaseModule {
  closeDatabase: () => void;
  getDatabase: () => {
    exec: (sql: string) => void;
    query: (sql: string) => {
      all: () => unknown[];
      get: () => unknown;
    };
  };
  initializeDatabase: () => Promise<void>;
}

interface CliOptions {
  dataDir: string;
  applySeed: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const repoRoot = resolve(import.meta.dir, "..", "..");
  let dataDir = join(repoRoot, "data");
  let applySeed = true;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === "--skip-apply") {
      applySeed = false;
      continue;
    }

    if (arg === "--data-dir") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error("Missing value for --data-dir");
      }
      dataDir = resolve(repoRoot, nextArg);
      index++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dataDir,
    applySeed,
  };
}

async function writeRuntimeArtifacts(dataDir: string): Promise<{
  sqlPath: string;
  keyDir: string;
}> {
  const sqlSourcePath = join(import.meta.dir, "ui-demo-seed.sql");
  const keySourceDir = join(import.meta.dir, "ssh-server-keys");

  const sqlPath = join(dataDir, "ui-demo-seed.sql");
  const keyDir = join(dataDir, "ssh-server-keys");

  await mkdir(dataDir, { recursive: true });
  await mkdir(keyDir, { recursive: true });
  await Bun.write(sqlPath, Bun.file(sqlSourcePath));

  for (const keyFileName of new Bun.Glob("*.json").scanSync({ cwd: keySourceDir })) {
    await Bun.write(
      join(keyDir, keyFileName),
      Bun.file(join(keySourceDir, keyFileName)),
    );
  }

  return {
    sqlPath,
    keyDir,
  };
}

async function loadDatabaseModule(): Promise<DatabaseModule> {
  return await import("../../src/persistence/database");
}

async function applySeedToDatabase(dataDir: string, sqlPath: string): Promise<void> {
  process.env["CLANKY_DATA_DIR"] = dataDir;
  const database = await loadDatabaseModule();
  await database.initializeDatabase();

  try {
    const sql = await Bun.file(sqlPath).text();
    const db = database.getDatabase();
    db.exec(sql);

    const foreignKeyFailures = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(
        `Demo seed left foreign-key violations: ${JSON.stringify(foreignKeyFailures.slice(0, 5))}`,
      );
    }

    const legacyTables = db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('ssh_server_sessions', 'port_forwards', 'execution_nodes')
      ORDER BY name
    `).all() as Array<{ name?: unknown }>;
    if (legacyTables.length > 0) {
      const names = legacyTables
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string");
      throw new Error(`Demo seed requires the consolidated schema; legacy tables remain: ${names.join(", ")}`);
    }

    const schemaVersionRow = db.query(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version?: unknown };
    const schemaVersion = schemaVersionRow.version;
    if (schemaVersion !== 56) {
      throw new Error(`Demo seed requires schema version 56, got ${schemaVersion}`);
    }

    const requiredDemoRows: Array<[string, string]> = [
      ["webapp_users", "id = 'demo-user'"],
      ["execution_hosts", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["workspaces", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["tasks", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["chats", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["agents", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["agent_runs", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["terminal_sessions", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["preview_sessions", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["vnc_sessions", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["provisioning_jobs", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["review_comments", "user_id = 'demo-user' AND id LIKE 'demo-%'"],
      ["task_transcript_entries", "user_id = 'demo-user' AND task_id LIKE 'demo-%'"],
      ["chat_transcript_entries", "user_id = 'demo-user' AND chat_id LIKE 'demo-%'"],
      ["agent_run_transcript_entries", "user_id = 'demo-user' AND agent_run_id LIKE 'demo-%'"],
    ];
    for (const [table, predicate] of requiredDemoRows) {
      const row = db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as {
        count?: unknown;
      };
      if (typeof row.count !== "number" || row.count === 0) {
        throw new Error(`Demo seed did not create required rows in ${table}`);
      }
    }
  } finally {
    database.closeDatabase();
  }
}

async function main(): Promise<void> {
  process.env["CLANKY_LOG_LEVEL"] ??= "fatal";

  const options = parseArgs(process.argv.slice(2));
  const { sqlPath, keyDir } = await writeRuntimeArtifacts(options.dataDir);

  if (options.applySeed) {
    await applySeedToDatabase(options.dataDir, sqlPath);
  }

  console.log(`Demo UI artifacts written to ${options.dataDir}`);
  console.log(`SQL seed: ${sqlPath}`);
  console.log(`SSH keys: ${keyDir}`);
  console.log(options.applySeed ? "Database seed applied." : "Database seed skipped.");
}

await main();
