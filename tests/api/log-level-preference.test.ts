/**
 * API integration tests for log level preference endpoints.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getLogLevel, setLogLevel } from "../../src/core/logger";

let testDataDir: string;

describe("Log Level Preference API", () => {
  // Capture the log level before any test modifies it,
  // so we can restore it and avoid polluting other test files in the same process.
  const originalActiveLevel = getLogLevel();

  beforeEach(async () => {
    // Create a temp directory for each test
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-test-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    
    // Initialize the database
    const { ensureDataDirectories } = await import("../../src/persistence/database");
    await ensureDataDirectories();
  });

  afterEach(async () => {
    // Restore the log level that was active before tests ran
    // (e.g., "fatal" when running under CLANKY_LOG_LEVEL=fatal)
    setLogLevel(originalActiveLevel);

    // Close the database before cleaning up
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();

    // Clean up
    delete process.env["CLANKY_DATA_DIR"];
    await rm(testDataDir, { recursive: true });
  });

  describe("GET /api/preferences/log-level", () => {
    test("returns info by default", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].GET;
      const response = await handler();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.level).toBe("info");
      expect(body.defaultLevel).toBe("info");
      expect(body.availableLevels).toContain("debug");
    });

    test("returns current preference value", async () => {
      const { setLogLevelPreference } = await import("../../src/persistence/preferences");
      await setLogLevelPreference("debug");

      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].GET;
      const response = await handler();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.level).toBe("debug");
    });

    test("response has correct content-type", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].GET;
      const response = await handler();

      expect(response.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("PUT /api/preferences/log-level", () => {
    test("sets preference to debug", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
      
      const request = new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "debug" }),
      });
      
      const response = await handler(request);
      expect(response.status).toBe(200);
      
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.level).toBe("debug");

      // Verify it was persisted
      const { getLogLevelPreference } = await import("../../src/persistence/preferences");
      expect(await getLogLevelPreference()).toBe("debug");
    });

    test("sets preference to error", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
      
      const request = new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "error" }),
      });
      
      const response = await handler(request);
      expect(response.status).toBe(200);

      // Verify it was persisted
      const { getLogLevelPreference } = await import("../../src/persistence/preferences");
      expect(await getLogLevelPreference()).toBe("error");
    });

    test("accepts all valid log levels", async () => {
      const validLevels = ["silly", "trace", "debug", "info", "warn", "error", "fatal"];
      
      for (const level of validLevels) {
        const { preferencesRoutes } = await import("../../src/api/models");
        const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
        
        const request = new Request("http://localhost/api/preferences/log-level", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level }),
        });
        
        const response = await handler(request);
        expect(response.status).toBe(200);
      }
    });

    test("returns error for invalid body - missing level", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
      
      const request = new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      
      const response = await handler(request);
      expect(response.status).toBe(400);
      
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });

    test("returns error for invalid log level", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
      
      const request = new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "invalid_level" }),
      });
      
      const response = await handler(request);
      expect(response.status).toBe(400);
      
      const body = await response.json();
      expect(body.error).toBe("invalid_level");
    });

    test("returns error for numeric level (should be string)", async () => {
      const { preferencesRoutes } = await import("../../src/api/models");
      const handler = preferencesRoutes["/api/preferences/log-level"].PUT;
      
      const request = new Request("http://localhost/api/preferences/log-level", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: 3 }),
      });
      
      const response = await handler(request);
      expect(response.status).toBe(400);
      
      const body = await response.json();
      expect(body.error).toBe("validation_error");
    });
  });
});
