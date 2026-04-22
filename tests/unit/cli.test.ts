import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadStoredCliCredentials,
  runCli,
  saveStoredCliCredentials,
  type StoredCliCredentials,
} from "../../src/cli";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createFetchMock(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: fetch.preconnect,
  }) as typeof fetch;
}

describe("ralpher cli", () => {
  let dataDir: string;
  let homeDir: string;
  let originalDataDir: string | undefined;
  let originalCliHome: string | undefined;
  let originalHome: string | undefined;
  let originalBaseUrl: string | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-cli-test-"));
    homeDir = await mkdtemp(join(tmpdir(), "ralpher-cli-home-"));
    originalDataDir = process.env["RALPHER_DATA_DIR"];
    originalCliHome = process.env["RALPHER_CLI_HOME"];
    originalHome = process.env["HOME"];
    originalBaseUrl = process.env["RALPHER_BASE_URL"];
    process.env["RALPHER_DATA_DIR"] = dataDir;
    process.env["HOME"] = homeDir;
    delete process.env["RALPHER_CLI_HOME"];
    delete process.env["RALPHER_BASE_URL"];
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env["RALPHER_DATA_DIR"];
    } else {
      process.env["RALPHER_DATA_DIR"] = originalDataDir;
    }
    if (originalCliHome === undefined) {
      delete process.env["RALPHER_CLI_HOME"];
    } else {
      process.env["RALPHER_CLI_HOME"] = originalCliHome;
    }
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalBaseUrl === undefined) {
      delete process.env["RALPHER_BASE_URL"];
    } else {
      process.env["RALPHER_BASE_URL"] = originalBaseUrl;
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("auth requires an explicit base URL instead of defaulting to localhost", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["auth"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "ERR:Error: Missing value for --base-url\n\nUsage:\n  ralpher cli auth --base-url <url> [--client-id <client-id>] [--cookies <cookie-header>]\n  ralpher cli status [--base-url <url>]",
    ]);
  });

  test("auth completes the device flow, stores cookies, and reuses them on requests", async () => {
    const output: string[] = [];
    const fetchCalls: Array<{
      url: string;
      method: string;
      body?: string;
      authorization?: string | null;
      cookie?: string | null;
      origin?: string | null;
    }> = [];
    let tokenPollCount = 0;

    const exitCode = await runCli([
      "auth",
      "--base-url",
      "http://example.test",
      "--cookies",
      "authentik_proxy=proxy-cookie-value; session_hint=browser;",
    ], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      sleep: async () => undefined,
      now: () => new Date("2026-04-21T17:15:00.000Z"),
      fetchFn: createFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
          authorization: init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : init?.headers && "authorization" in init.headers
              ? String(init.headers["authorization"])
              : null,
          cookie: init?.headers instanceof Headers
            ? init.headers.get("cookie")
            : init?.headers && "cookie" in init.headers
              ? String(init.headers["cookie"])
              : null,
          origin: init?.headers instanceof Headers
            ? init.headers.get("origin")
            : init?.headers && "origin" in init.headers
              ? String(init.headers["origin"])
              : null,
        });

        if (url === "http://example.test/api/auth/device") {
          return jsonResponse(200, {
            device_code: "device-code-1",
            user_code: "ABCD-EFGH",
            verification_uri: "http://example.test/device",
            verification_uri_complete: "http://example.test/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 1,
          });
        }

        if (url === "http://example.test/api/auth/token") {
          tokenPollCount += 1;
          if (tokenPollCount === 1) {
            return jsonResponse(400, {
              error: "authorization_pending",
              error_description: "Still waiting",
            });
          }

          return jsonResponse(200, {
            access_token: "access-token-1",
            refresh_token: "refresh-token-1",
            token_type: "Bearer",
            expires_in: 600,
            scope: "",
          });
        }

        throw new Error(`Unexpected fetch to ${url}`);
      }),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "Open: http://example.test/device?user_code=ABCD-EFGH",
      "Code: ABCD-EFGH",
      "Waiting for approval...",
      "Authenticated with http://example.test",
    ]);

    const storedCredentials = await loadStoredCliCredentials();
    expect(storedCredentials).toEqual({
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie-value; session_hint=browser",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    });
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "http://example.test/api/auth/device",
      "http://example.test/api/auth/token",
      "http://example.test/api/auth/token",
    ]);
    expect(fetchCalls.every((call) => call.origin === "http://example.test")).toBe(true);
    expect(fetchCalls.every((call) => call.cookie === "authentik_proxy=proxy-cookie-value; session_hint=browser")).toBe(true);
    expect(await Bun.file(join(homeDir, ".ralpher", "cli-auth.json")).exists()).toBe(true);
    expect(await Bun.file(join(dataDir, "cli-auth.json")).exists()).toBe(false);
  });

  test("auth rejects invalid cookie strings", async () => {
    const output: string[] = [];

    const exitCode = await runCli([
      "auth",
      "--base-url",
      "http://example.test",
      "--cookies",
      "definitely-not-a-cookie",
    ], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "ERR:Error: Invalid value for --cookies\n\nUsage:\n  ralpher cli auth --base-url <url> [--client-id <client-id>] [--cookies <cookie-header>]\n  ralpher cli status [--base-url <url>]",
    ]);
  });

  test("status refreshes expired credentials before probing auth status", async () => {
    const output: string[] = [];
    const requests: Array<{
      url: string;
      authorization?: string | null;
      cookie?: string | null;
      origin?: string | null;
    }> = [];

    const expiredCredentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie-value; session_hint=browser",
      accessTokenExpiresAt: "2026-04-21T17:14:59.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    };
    await saveStoredCliCredentials(expiredCredentials);

    const exitCode = await runCli(["status"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      now: () => new Date("2026-04-21T17:15:00.000Z"),
      fetchFn: createFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : init?.headers && "authorization" in init.headers
              ? String(init.headers["authorization"])
              : null,
          cookie: init?.headers instanceof Headers
            ? init.headers.get("cookie")
            : init?.headers && "cookie" in init.headers
              ? String(init.headers["cookie"])
              : null,
          origin: init?.headers instanceof Headers
            ? init.headers.get("origin")
            : init?.headers && "origin" in init.headers
              ? String(init.headers["origin"])
              : null,
        });

        if (url === "http://example.test/api/auth/token") {
          return jsonResponse(200, {
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            token_type: "Bearer",
            expires_in: 600,
            scope: "",
          });
        }

        if (url === "http://example.test/api/auth/status") {
          return jsonResponse(200, {
            authenticated: true,
            authKind: "bearer",
            subject: "ralpher-user",
            clientId: "ralpher-cli",
            scope: "",
          });
        }

        throw new Error(`Unexpected fetch to ${url}`);
      }),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "Logged in to http://example.test as ralpher-cli.",
    ]);
    expect(requests).toEqual([
      {
        url: "http://example.test/api/auth/token",
        authorization: null,
        cookie: "authentik_proxy=proxy-cookie-value; session_hint=browser",
        origin: "http://example.test",
      },
      {
        url: "http://example.test/api/auth/status",
        authorization: "Bearer fresh-access",
        cookie: "authentik_proxy=proxy-cookie-value; session_hint=browser",
        origin: "http://example.test",
      },
    ]);

    expect(await loadStoredCliCredentials()).toEqual({
      ...expiredCredentials,
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    });
  });

  test("status reports when no credentials are stored", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["status"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "Not logged in.",
    ]);
  });
});
