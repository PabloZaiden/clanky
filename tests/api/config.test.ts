/**
 * API integration tests for config endpoint.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { settingsRoutes } from "../../src/api/settings";
import { closeDatabase, ensureDataDirectories } from "../../src/persistence/database";

describe("GET /api/config", () => {
  const originalEnv = process.env["RALPHER_REMOTE_ONLY"];
  const originalDisablePasskey = process.env["RALPHER_DISABLE_PASSKEY"];
  const originalDataDir = process.env["RALPHER_DATA_DIR"];
  const handler = settingsRoutes["/api/config"].GET;
  let tempDataDir: string | undefined;

  function createConfigRequest(headers?: HeadersInit): Request {
    return new Request("http://localhost/api/config", { headers });
  }

  afterEach(async () => {
    closeDatabase();
    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true });
      tempDataDir = undefined;
    }
    if (originalEnv === undefined) {
      delete process.env["RALPHER_REMOTE_ONLY"];
    } else {
      process.env["RALPHER_REMOTE_ONLY"] = originalEnv;
    }
    if (originalDisablePasskey === undefined) {
      delete process.env["RALPHER_DISABLE_PASSKEY"];
    } else {
      process.env["RALPHER_DISABLE_PASSKEY"] = originalDisablePasskey;
    }
    if (originalDataDir === undefined) {
      delete process.env["RALPHER_DATA_DIR"];
    } else {
      process.env["RALPHER_DATA_DIR"] = originalDataDir;
    }
  });

  async function initializeConfigDatabase(): Promise<void> {
    tempDataDir = await mkdtemp(join(tmpdir(), "ralpher-config-test-"));
    process.env["RALPHER_DATA_DIR"] = tempDataDir;
    await ensureDataDirectories();
  }

  test("returns remoteOnly: false when env var is not set", async () => {
    delete process.env["RALPHER_REMOTE_ONLY"];
    delete process.env["RALPHER_DISABLE_PASSKEY"];
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      remoteOnly: false,
      basicAuthEnabled: false,
      publicBasePath: null,
      passkeyAuth: {
        passkeyConfigured: false,
        passkeyDisabled: false,
        passkeyRequired: false,
        authenticated: false,
      },
    });
  });

  test("returns remoteOnly: true when env var is 'true'", async () => {
    process.env["RALPHER_REMOTE_ONLY"] = "true";
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ remoteOnly: true }));
  });

  test("returns remoteOnly: true when env var is '1'", async () => {
    process.env["RALPHER_REMOTE_ONLY"] = "1";
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ remoteOnly: true }));
  });

  test("returns remoteOnly: true when env var is 'yes'", async () => {
    process.env["RALPHER_REMOTE_ONLY"] = "yes";
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ remoteOnly: true }));
  });

  test("returns normalized publicBasePath from X-Forwarded-Prefix", async () => {
    delete process.env["RALPHER_REMOTE_ONLY"];
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest({
      "x-forwarded-prefix": "/ralpher/",
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ remoteOnly: false, publicBasePath: "/ralpher" }));
  });

  test("returns disabled passkey status when env var is enabled", async () => {
    process.env["RALPHER_DISABLE_PASSKEY"] = "true";
    await initializeConfigDatabase();

    const response = await handler(createConfigRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({
      passkeyAuth: {
        passkeyConfigured: false,
        passkeyDisabled: true,
        passkeyRequired: false,
        authenticated: false,
      },
    }));
  });

  test("response has correct content-type", async () => {
    await initializeConfigDatabase();
    const response = await handler(createConfigRequest());

    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
