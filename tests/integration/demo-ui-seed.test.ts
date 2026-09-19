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
  database.close();

  await runSeed(dataDir);

  const repeatedDatabase = new Database(join(dataDir, "clanky.db"));
  repeatedDatabase.exec("PRAGMA foreign_keys = ON");
  expect(repeatedDatabase.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(repeatedDatabase.query(`
    SELECT value
    FROM preferences
    WHERE key = 'unrelated-preference' AND user_id = 'unrelated-user'
  `).get()).toEqual({ value: "keep-me" });
  const demoWorkspaceCount = repeatedDatabase.query(`
    SELECT COUNT(*) AS count
    FROM workspaces
    WHERE user_id = 'demo-user'
  `).get() as { count: number };
  expect(demoWorkspaceCount.count).toBeGreaterThan(0);
  repeatedDatabase.close();
});
