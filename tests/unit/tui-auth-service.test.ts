import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AuthService } from "../../apps/tui/src/services/auth-service";
import {
  loadStoredCliCredentials,
  saveStoredCliCredentials,
  type StoredCliCredentials,
} from "../../src/cli";

function createFetchMock(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: fetch.preconnect,
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("tui auth service", () => {
  let cliHomeDir: string;
  let originalCliHome: string | undefined;

  beforeEach(async () => {
    cliHomeDir = await mkdtemp(join(tmpdir(), "ralpher-tui-auth-home-"));
    originalCliHome = process.env["RALPHER_CLI_HOME"];
    process.env["RALPHER_CLI_HOME"] = cliHomeDir;
  });

  afterEach(async () => {
    if (originalCliHome === undefined) {
      delete process.env["RALPHER_CLI_HOME"];
    } else {
      process.env["RALPHER_CLI_HOME"] = originalCliHome;
    }
    await rm(cliHomeDir, { recursive: true, force: true });
  });

  test("refreshes expired credentials and persists the rotated token set", async () => {
    const storedCredentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie; session_hint=browser",
      accessTokenExpiresAt: "2026-04-21T17:14:59.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    };
    await saveStoredCliCredentials(storedCredentials);

    const requests: Array<{
      url: string;
      cookie?: string | null;
      origin?: string | null;
    }> = [];
    const authService = new AuthService({
      fetchFn: createFetchMock(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
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

        return jsonResponse(200, {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          token_type: "Bearer",
          expires_in: 600,
          scope: "",
        });
      }),
      now: () => new Date("2026-04-21T17:15:00.000Z"),
    });

    const firstCredentials = await authService.getCredentials();
    const secondCredentials = await authService.getCredentials();

    expect(firstCredentials).toEqual({
      ...storedCredentials,
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    });
    expect(secondCredentials).toEqual(firstCredentials);
    expect(authService.getCachedCredentials()).toEqual(firstCredentials);
    expect(requests).toEqual([
      {
        url: "http://example.test/api/auth/token",
        cookie: "authentik_proxy=proxy-cookie; session_hint=browser",
        origin: "http://example.test",
      },
    ]);
    expect(await loadStoredCliCredentials()).toEqual({
      ...storedCredentials,
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    });
  });
});
