/**
 * Materialize the versioned demo UI seed into a runtime data directory and,
 * unless disabled, apply it to the SQLite database.
 *
 * Usage:
 *   bun tests/test-data-generation/generate-demo-ui-data.ts
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --skip-apply
 *   bun tests/test-data-generation/generate-demo-ui-data.ts --data-dir ./tmp/demo-data
 */

import { mkdir } from "fs/promises";
import { join, resolve } from "path";

interface DatabaseModule {
  closeDatabase: () => void;
  getDatabase: () => {
    exec: (sql: string) => void;
    query: (sql: string) => { all: () => unknown[] };
    run: (sql: string) => void;
  };
  initializeDatabase: () => Promise<void>;
}

interface CliOptions {
  dataDir: string;
  applySeed: boolean;
}

const DEMO_OWNER_USER_ID = "admin";
const USER_OWNED_SEED_TABLES = [
  "ssh_servers",
  "ssh_server_sessions",
  "workspaces",
  "ssh_sessions",
  "tasks",
  "chats",
  "agents",
  "review_comments",
  "preview_sessions",
] as const;

function prepareSeedSqlForCurrentSchema(sql: string): string {
  let preparedSql = sql;
  for (const tableName of USER_OWNED_SEED_TABLES) {
    const insertPattern = new RegExp(
      `INSERT INTO ${tableName} \\([\\s\\S]*?\\nON CONFLICT\\(id\\)[\\s\\S]*?;`,
      "g",
    );

    preparedSql = preparedSql.replaceAll(insertPattern, (statement: string) => {
      const columnListEnd = statement.indexOf("\n) VALUES");
      const columnList = columnListEnd === -1 ? statement : statement.slice(0, columnListEnd);
      if (columnList.includes("\n  user_id,")) {
        return statement;
      }

      return statement
        .replace(
          `INSERT INTO ${tableName} (\n  id,`,
          `INSERT INTO ${tableName} (\n  id,\n  user_id,`,
        )
        .replace(/\) VALUES \(\n  ('demo-[^']+',)/, `) VALUES (\n  $1\n  '${DEMO_OWNER_USER_ID}',`);
    });
  }
  return preparedSql;
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

  const sql = await Bun.file(sqlSourcePath).text();
  await Bun.write(sqlPath, prepareSeedSqlForCurrentSchema(sql));

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

async function addLegacyTranscriptSeedColumns(database: DatabaseModule): Promise<void> {
  const db = database.getDatabase();
  const tables = ["chats", "tasks", "agent_runs"] as const;
  const columns = ["messages", "logs", "tool_calls"] as const;

  for (const table of tables) {
    const existingColumns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const existingColumnNames = new Set(existingColumns.map((column) => column.name));
    for (const column of columns) {
      if (!existingColumnNames.has(column)) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    }
  }
}

async function migrateSeedTranscripts(): Promise<void> {
  const [{ migrateLegacyChatTranscripts }, { migrateLegacyTaskTranscripts }, { migrateLegacyAgentRunTranscripts }, { dropLegacyTranscriptColumns }] = await Promise.all([
    import("../../src/persistence/chats"),
    import("../../src/persistence/tasks"),
    import("../../src/persistence/agents"),
    import("../../src/persistence/transcripts/store"),
  ]);

  migrateLegacyChatTranscripts();
  migrateLegacyTaskTranscripts();
  migrateLegacyAgentRunTranscripts();
  dropLegacyTranscriptColumns("chat");
  dropLegacyTranscriptColumns("task");
  dropLegacyTranscriptColumns("agent_run");
}

async function applySeedToDatabase(dataDir: string, sqlPath: string): Promise<void> {
  process.env["CLANKY_DATA_DIR"] = dataDir;
  const database = await loadDatabaseModule();
  await database.initializeDatabase();

  try {
    // The checked-in seed remains readable as a legacy fixture, then follows
    // the same backfill/drop path as an upgraded production database.
    await addLegacyTranscriptSeedColumns(database);
    const sql = await Bun.file(sqlPath).text();
    database.getDatabase().exec(sql);
    await migrateSeedTranscripts();
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
