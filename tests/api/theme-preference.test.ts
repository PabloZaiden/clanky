/**
 * API integration tests for theme preference endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let testDataDir: string;

describe("Theme Preference API", () => {
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-theme-test-"));
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

  describe("GET /api/preferences/theme", () => {
    test("returns system by default", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].GET;
      const response = await handler();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.theme).toBe("system");
    });

    test("returns the persisted theme preference", async () => {
      const { setThemePreference } = await import("../../src/persistence/preferences");
      await setThemePreference("dark");

      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].GET;
      const response = await handler();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.theme).toBe("dark");
    });
  });

  describe("PUT /api/preferences/theme", () => {
    test("persists explicit theme values", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].PUT;

      for (const theme of ["light", "dark", "system"]) {
        const request = new Request("http://localhost/api/preferences/theme", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme }),
        });

        const response = await handler(request);
        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body.success).toBe(true);
        expect(body.theme).toBe(theme);
      }
    });

    test("writes the persisted preference", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].PUT;

      const request = new Request("http://localhost/api/preferences/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "light" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(200);

      const { getThemePreference } = await import("../../src/persistence/preferences");
      expect(await getThemePreference()).toBe("light");
    });

    test("rejects missing theme", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].PUT;

      const request = new Request("http://localhost/api/preferences/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("rejects invalid theme values", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/theme"].PUT;

      const request = new Request("http://localhost/api/preferences/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: "sepia" }),
      });

      const response = await handler(request);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });
  });
});
