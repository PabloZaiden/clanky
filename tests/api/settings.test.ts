/**
 * API integration tests for destructive settings maintenance operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "../setup";

describe("Settings API integration", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    context = await setupTestContext();
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(context);
  });

  test("resets the database before returning success", async () => {
    const beforeResponse = await fetch(`${baseUrl}/api/workspaces`);
    expect(beforeResponse.status).toBe(200);
    expect(await beforeResponse.json()).toHaveLength(1);

    const resetResponse = await fetch(`${baseUrl}/api/settings/reset-all`, {
      method: "POST",
    });
    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      success: true,
      message: "All settings have been reset. Database recreated.",
    });

    const afterResponse = await fetch(`${baseUrl}/api/workspaces`);
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual([]);
  });
});
