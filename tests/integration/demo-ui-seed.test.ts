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

const demoRowCountQueries = {
  webapp_users: "SELECT COUNT(*) AS count FROM webapp_users WHERE id = 'demo-user'",
  execution_hosts: "SELECT COUNT(*) AS count FROM execution_hosts WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  workspaces: "SELECT COUNT(*) AS count FROM workspaces WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  tasks: "SELECT COUNT(*) AS count FROM tasks WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  chats: "SELECT COUNT(*) AS count FROM chats WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  agents: "SELECT COUNT(*) AS count FROM agents WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  agent_runs: "SELECT COUNT(*) AS count FROM agent_runs WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  terminal_sessions: "SELECT COUNT(*) AS count FROM terminal_sessions WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  preview_sessions: "SELECT COUNT(*) AS count FROM preview_sessions WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  provisioning_jobs: "SELECT COUNT(*) AS count FROM provisioning_jobs WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  review_comments: "SELECT COUNT(*) AS count FROM review_comments WHERE user_id = 'demo-user' AND id LIKE 'demo-%'",
  task_transcript_entries: "SELECT COUNT(*) AS count FROM task_transcript_entries WHERE user_id = 'demo-user' AND task_id LIKE 'demo-%'",
  chat_transcript_entries: "SELECT COUNT(*) AS count FROM chat_transcript_entries WHERE user_id = 'demo-user' AND chat_id LIKE 'demo-%'",
  agent_run_transcript_entries: "SELECT COUNT(*) AS count FROM agent_run_transcript_entries WHERE user_id = 'demo-user' AND agent_run_id LIKE 'demo-%'",
} as const;

function captureDemoRowCounts(database: Database): Record<string, number> {
  return Object.fromEntries(
    Object.entries(demoRowCountQueries).map(([name, query]) => {
      const row = database.query(query).get() as { count?: unknown };
      if (typeof row.count !== "number") {
        throw new Error(`Demo row count query returned an invalid count for ${name}`);
      }
      return [name, row.count];
    }),
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

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("demo UI seed preserves unrelated data and referential integrity when rerun", async () => {
  const dataDir = join("/tmp", `clanky-demo-test-${crypto.randomUUID()}`);
  temporaryDirectories.push(dataDir);
  await mkdir(dataDir, { recursive: true });

  await runSeed(dataDir);

  const database = new Database(join(dataDir, "clanky.db"));
  database.exec("PRAGMA foreign_keys = ON");
  const initialDemoRowCounts = captureDemoRowCounts(database);
  expect(initialDemoRowCounts["workspaces"]).toBeGreaterThan(0);
  database.close();

  const unrelatedDatabase = new Database(join(dataDir, "clanky.db"));
  unrelatedDatabase.exec("PRAGMA foreign_keys = ON");
  unrelatedDatabase.exec(`
    INSERT INTO webapp_users (
      id, username, role, auth_version, created_at, updated_at
    ) VALUES (
      'unrelated-user', 'unrelated', 'user', 1,
      '2026-04-17T14:00:00.000Z', '2026-04-17T14:00:00.000Z'
    );
    INSERT INTO preferences (key, user_id, value)
    VALUES ('unrelated-preference', 'unrelated-user', 'keep-me');
  `);
  unrelatedDatabase.close();

  await runSeed(dataDir);

  const repeatedDatabase = new Database(join(dataDir, "clanky.db"));
  repeatedDatabase.exec("PRAGMA foreign_keys = ON");
  expect(captureDemoRowCounts(repeatedDatabase)).toEqual(initialDemoRowCounts);
  expect(repeatedDatabase.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(repeatedDatabase.query(`
    SELECT value
    FROM preferences
    WHERE key = 'unrelated-preference' AND user_id = 'unrelated-user'
  `).get()).toEqual({ value: "keep-me" });
  repeatedDatabase.close();
});
