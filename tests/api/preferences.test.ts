/**
 * API integration tests for user preferences.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("User preferences API", () => {
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

  test("persists, trims, and clears the optional GitHub username", async () => {
    const initialResponse = await fetch(`${baseUrl}/api/preferences/github-username`);
    expect(initialResponse.status).toBe(200);
    expect(await initialResponse.json()).toEqual({ githubUsername: null });

    const saveResponse = await fetch(`${baseUrl}/api/preferences/github-username`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUsername: " octocat " }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toEqual({
      success: true,
      githubUsername: "octocat",
    });

    const savedResponse = await fetch(`${baseUrl}/api/preferences/github-username`);
    expect(savedResponse.status).toBe(200);
    expect(await savedResponse.json()).toEqual({ githubUsername: "octocat" });

    const clearResponse = await fetch(`${baseUrl}/api/preferences/github-username`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUsername: "   " }),
    });
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual({
      success: true,
      githubUsername: null,
    });

    const clearedResponse = await fetch(`${baseUrl}/api/preferences/github-username`);
    expect(clearedResponse.status).toBe(200);
    expect(await clearedResponse.json()).toEqual({ githubUsername: null });
  });

  test("rejects a GitHub username with an invalid type", async () => {
    const response = await fetch(`${baseUrl}/api/preferences/github-username`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUsername: 123 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation_error" });
  });

  test("accepts GitHub login syntax and rejects invalid usernames", async () => {
    const validResponse = await fetch(`${baseUrl}/api/preferences/github-username`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUsername: "a".repeat(39) }),
    });
    expect(validResponse.status).toBe(200);

    for (const githubUsername of [
      "octo_cat",
      "-octocat",
      "octocat-",
      "octo--cat",
      "a".repeat(40),
    ]) {
      const response = await fetch(`${baseUrl}/api/preferences/github-username`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "validation_error" });
    }
  });
});
