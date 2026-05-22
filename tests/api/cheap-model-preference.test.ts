/**
 * API integration tests for cheap helper-model preference endpoints.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDataDir: string;

describe("Cheap helper model preference API", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;

    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  test("stores and retrieves a custom cheap helper model selection", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const putHandler = preferencesRoutes["/api/preferences/last-cheap-model"].PUT;
    const getHandler = preferencesRoutes["/api/preferences/last-cheap-model"].GET;

    const putResponse = await putHandler(new Request("http://localhost/api/preferences/last-cheap-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "custom",
        model: {
          providerID: "openai",
          modelID: "gpt-4o-mini",
          variant: "fast",
        },
      }),
    }));

    expect(putResponse.status).toBe(200);

    const getResponse = await getHandler();
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      mode: "custom",
      model: {
        providerID: "openai",
        modelID: "gpt-4o-mini",
        variant: "fast",
      },
    });
  });

  test("rejects invalid cheap helper model payloads", async () => {
    const { preferencesRoutes } = await import("../../src/api/models");
    const putHandler = preferencesRoutes["/api/preferences/last-cheap-model"].PUT;

    const response = await putHandler(new Request("http://localhost/api/preferences/last-cheap-model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "custom",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "validation_error",
    });
  });
});
