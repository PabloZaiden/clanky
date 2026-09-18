import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "..", "..");
const temporaryDirectories: string[] = [];

function getEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function runSeed(dataDir: string): Promise<void> {
  const process = Bun.spawn(
    [
      "bun",
      "tests/test-data-generation/generate-demo-ui-data.ts",
      "--data-dir",
      dataDir,
    ],
    {
      cwd: repoRoot,
      env: {
        ...getEnvironment(),
        CLANKY_DISABLE_PASSKEY: "true",
        CLANKY_LOG_LEVEL: "error",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(process.stderr).text();
    throw new Error(`Demo seed command failed with exit code ${exitCode}: ${stderr}`);
  }
}

function readDemoSnapshot(database: Database): string {
  const tables = [
    "execution_hosts",
    "workspaces",
    "tasks",
    "chats",
    "agents",
    "agent_runs",
    "terminal_sessions",
    "preview_sessions",
    "vnc_sessions",
    "provisioning_jobs",
    "review_comments",
    "task_transcript_entries",
    "chat_transcript_entries",
    "agent_run_transcript_entries",
  ];
  return JSON.stringify(
    tables.map((table) => ({
      table,
      rows: database.query(`
        SELECT *
        FROM ${table}
        WHERE user_id = 'demo-user'
        ORDER BY rowid
      `).all(),
    })),
  );
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo UI seed is repeatable, isolated, and referentially complete", async () => {
  const dataDir = join("/tmp", `clanky-demo-test-${crypto.randomUUID()}`);
  temporaryDirectories.push(dataDir);
  await mkdir(dataDir, { recursive: true });

  await runSeed(dataDir);

  const database = new Database(join(dataDir, "clanky.db"));
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at
    ) VALUES (
      'unrelated-user', 'unrelated', 'user', 1,
      '2026-04-17T14:00:00.000Z', '2026-04-17T14:00:00.000Z'
    );
    INSERT INTO preferences (key, user_id, value)
    VALUES ('unrelated-preference', 'unrelated-user', 'keep-me');
  `);
  const firstSnapshot = readDemoSnapshot(database);
  database.close();

  await runSeed(dataDir);

  const repeatedDatabase = new Database(join(dataDir, "clanky.db"));
  repeatedDatabase.exec("PRAGMA foreign_keys = ON");
  expect(readDemoSnapshot(repeatedDatabase)).toBe(firstSnapshot);
  expect(repeatedDatabase.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(repeatedDatabase.query(`
    SELECT value
    FROM preferences
    WHERE key = 'unrelated-preference' AND user_id = 'unrelated-user'
  `).get()).toEqual({ value: "keep-me" });
  expect(repeatedDatabase.query(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('ssh_server_sessions', 'port_forwards', 'execution_nodes')
  `).all()).toEqual([]);
  expect(repeatedDatabase.query(`
    SELECT
      (SELECT COUNT(*) FROM workspaces WHERE user_id = 'demo-user') AS workspaces,
      (SELECT COUNT(*) FROM tasks WHERE user_id = 'demo-user') AS tasks,
      (SELECT COUNT(*) FROM chats WHERE user_id = 'demo-user') AS chats,
      (SELECT COUNT(*) FROM agent_runs WHERE user_id = 'demo-user') AS agent_runs,
      (SELECT COUNT(*) FROM task_transcript_entries WHERE user_id = 'demo-user') AS task_entries
  `).get()).toEqual({
    workspaces: 3,
    tasks: 5,
    chats: 3,
    agent_runs: 2,
    task_entries: 8,
  });
  repeatedDatabase.close();
});
