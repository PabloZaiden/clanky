import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { formatRalpherVersion } from "../../src/version";
import {
  findApiEndpoint,
  loadStoredCliCredentials,
  runCli,
  saveStoredCliCredentials,
  type StoredCliCredentials,
} from "../../src/cli";

const CLI_USAGE = [
  "Usage:",
  "  ralpher web",
  "  ralpher version",
  "  ralpher auth <base-url> [--client-id <client-id>] [--cookies <cookie-header>]",
  "  ralpher status [base-url]",
  "  ralpher api",
  "  ralpher api <endpoint> [--method <method>] [--payload <json>]",
  "  ralpher schema <endpoint>",
].join("\n");
const CLI_HELP = [formatRalpherVersion(), "", CLI_USAGE].join("\n");

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

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-cli-test-"));
    homeDir = await mkdtemp(join(tmpdir(), "ralpher-cli-home-"));
    originalDataDir = process.env["RALPHER_DATA_DIR"];
    originalCliHome = process.env["RALPHER_CLI_HOME"];
    originalHome = process.env["HOME"];
    process.env["RALPHER_DATA_DIR"] = dataDir;
    process.env["HOME"] = homeDir;
    delete process.env["RALPHER_CLI_HOME"];
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
    await rm(dataDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("shows usage when no command is provided", async () => {
    const output: string[] = [];

    const exitCode = await runCli([], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([CLI_HELP]);
  });

  test("prints the current version with the version command", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["version"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([formatRalpherVersion()]);
  });

  test("shows the current version in help output", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["help"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual([CLI_HELP]);
  });

  test("auth requires the base URL as the first positional argument", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["auth"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      `ERR:Error: Missing base URL argument for auth\n\n${CLI_USAGE}`,
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

    expect(await loadStoredCliCredentials()).toEqual({
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
      "http://example.test",
      "--cookies",
      "definitely-not-a-cookie",
    ], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      `ERR:Error: Invalid value for --cookies\n\n${CLI_USAGE}`,
    ]);
  });

  test("auth rejects cookie headers that mix valid and invalid pairs", async () => {
    const output: string[] = [];

    const exitCode = await runCli([
      "auth",
      "http://example.test",
      "--cookies",
      "authentik_proxy=proxy-cookie-value; definitely-not-a-cookie",
    ], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      `ERR:Error: Invalid value for --cookies\n\n${CLI_USAGE}`,
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

    const exitCode = await runCli(["status", "http://override.test"], {
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

        if (url === "http://override.test/api/auth/token") {
          return jsonResponse(200, {
            access_token: "fresh-access",
            refresh_token: "fresh-refresh",
            token_type: "Bearer",
            expires_in: 600,
            scope: "",
          });
        }

        if (url === "http://override.test/api/auth/status") {
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
      "Logged in to http://override.test as ralpher-cli.",
    ]);
    expect(requests).toEqual([
      {
        url: "http://override.test/api/auth/token",
        authorization: null,
        cookie: "authentik_proxy=proxy-cookie-value; session_hint=browser",
        origin: "http://override.test",
      },
      {
        url: "http://override.test/api/auth/status",
        authorization: "Bearer fresh-access",
        cookie: "authentik_proxy=proxy-cookie-value; session_hint=browser",
        origin: "http://override.test",
      },
    ]);

    expect(await loadStoredCliCredentials()).toEqual({
      ...expiredCredentials,
      baseUrl: "http://override.test",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    });
  });

  test("api lists the discoverable endpoints when called without a path", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["api"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(20);
    expect(output).toContain("GET /api/auth/status - Validate the current bearer token and return auth details.");
    expect(output).toContain("POST /api/provisioning-jobs - Start a remote provisioning job.");
  });

  test("api rejects unknown endpoints before attempting any network request", async () => {
    const output: string[] = [];
    let fetchCalled = false;
    await saveStoredCliCredentials({
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie-value",
      accessTokenExpiresAt: "2026-04-21T17:14:59.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    });

    const exitCode = await runCli(["api", "not-a-real-endpoint", "--method", "GET"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      now: () => new Date("2026-04-21T17:15:00.000Z"),
      fetchFn: createFetchMock(async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called for unknown endpoints");
      }),
    });

    expect(exitCode).toBe(1);
    expect(fetchCalled).toBe(false);
    expect(output).toEqual([
      "Unknown API endpoint: /api/not-a-real-endpoint",
    ]);
  });

  test("api sends authenticated requests to the stored server", async () => {
    const output: string[] = [];
    const requests: Array<{
      url: string;
      method: string;
      authorization?: string | null;
      cookie?: string | null;
      origin?: string | null;
      body?: string;
    }> = [];

    await saveStoredCliCredentials({
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "active-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie-value",
      accessTokenExpiresAt: "2027-04-21T18:00:00.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    });

    const exitCode = await runCli(["api", "loops/test-loop", "--method", "GET"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
      now: () => new Date("2026-04-21T17:15:00.000Z"),
      fetchFn: createFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
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
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return jsonResponse(200, {
          id: "test-loop",
          status: "running",
        });
      }),
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      {
        url: "http://example.test/api/loops/test-loop",
        method: "GET",
        authorization: "Bearer active-access",
        cookie: "authentik_proxy=proxy-cookie-value",
        origin: "http://example.test",
        body: undefined,
      },
    ]);
    expect(output).toEqual([
      "Status: 200 OK",
      JSON.stringify({
        id: "test-loop",
        status: "running",
      }, null, 2),
    ]);
  });

  test("api reports invalid JSON payloads as usage errors", async () => {
    const output: string[] = [];
    await saveStoredCliCredentials({
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "active-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie-value",
      accessTokenExpiresAt: "2027-04-21T18:00:00.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    });

    const exitCode = await runCli(["api", "loops/test-loop", "--method", "POST", "--payload", "{\"broken\""], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      `ERR:Error: Invalid JSON for --payload\n\n${CLI_USAGE}`,
    ]);
  });

  test("schema shows request metadata for known endpoints", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["schema", "auth/device"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(0);
    const rendered = output.join("\n");
    expect(rendered).toContain("Endpoint: /api/auth/device");
    expect(rendered).toContain("Methods: POST");
    expect(rendered).toContain("Description: Start a device authorization flow for CLI login.");
    expect(rendered).toContain("Request body schema:");
    expect(rendered).toContain("\"clientId\"");
  });

  test("schema matches dynamic endpoints and shows query schemas", async () => {
    const output: string[] = [];

    const exitCode = await runCli(["schema", "workspaces/workspace-1/files"], {
      out: (message: string) => output.push(message),
      err: (message: string) => output.push(`ERR:${message}`),
    });

    expect(exitCode).toBe(0);
    const rendered = output.join("\n");
    expect(rendered).toContain("Endpoint: /api/workspaces/:id/files");
    expect(rendered).toContain("Methods: GET");
    expect(rendered).toContain("Query schema:");
    expect(rendered).toContain("\"path\"");
  });

  test("api catalog escapes regex metacharacters in static route segments", () => {
    expect(findApiEndpoint(".well-known/jwks.json")?.path).toBe("/.well-known/jwks.json");
    expect(findApiEndpoint(".well-known/jwksXjson")).toBeNull();
  });
});
