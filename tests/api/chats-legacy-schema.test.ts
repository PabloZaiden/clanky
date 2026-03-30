import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { apiRoutes } from "../../src/api";

describe("Chats API legacy schema compatibility", () => {
  let dataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-api-chats-legacy-"));
    previousDataDir = process.env["RALPHER_DATA_DIR"];
    process.env["RALPHER_DATA_DIR"] = dataDir;

    const legacyDb = new Database(join(dataDir, "ralpher.db"));
    legacyDb.run(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    legacyDb.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
      1,
      "legacy_reset_one",
      "2025-01-01T00:00:00.000Z",
    ]);
    legacyDb.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
      2,
      "legacy_reset_two",
      "2025-01-01T00:00:00.000Z",
    ]);
    legacyDb.close();

    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });

    if (previousDataDir === undefined) {
      delete process.env["RALPHER_DATA_DIR"];
    } else {
      process.env["RALPHER_DATA_DIR"] = previousDataDir;
    }
  });

  test("returns an empty chat list instead of failing when startup repairs a legacy database", async () => {
    const response = await fetch(`${baseUrl}/api/chats`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
