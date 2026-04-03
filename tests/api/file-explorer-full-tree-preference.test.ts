/**
 * API integration tests for file explorer full-tree preference endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDataDir: string;

describe("File Explorer Full Tree Preference API", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-test-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  test("GET returns enabled: true by default", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const response = await preferencesRoutes["/api/preferences/file-explorer-full-tree"].GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
  });

  test("PUT updates the persisted preference", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const response = await preferencesRoutes["/api/preferences/file-explorer-full-tree"].PUT(
      new Request("http://localhost/api/preferences/file-explorer-full-tree", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const { getFileExplorerFullTreeEnabled } = await import("../../src/persistence/preferences");
    expect(await getFileExplorerFullTreeEnabled()).toBe(false);
  });

  test("PUT rejects invalid request bodies", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const response = await preferencesRoutes["/api/preferences/file-explorer-full-tree"].PUT(
      new Request("http://localhost/api/preferences/file-explorer-full-tree", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "sometimes" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "validation_error",
    });
  });
});
