import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  getAuthContextHeaders,
  getCliRequestAuthContext,
  runStatusCommand,
  saveStoredCliCredentials,
  type StoredCliCredentials,
} from "../../src/client-sdk/cli-auth";

interface FetchCall {
  url: string;
  headers: Headers;
}

function createFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      }
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headers,
      });
      return await responder(input instanceof Request ? input.url : String(input), init);
    },
    { preconnect: fetch.preconnect },
  );
  return { fetchFn, calls };
}

function authStatusResponse(authKind: string, clientId: string | null = null): Response {
  return Response.json({
    authenticated: true,
    authKind,
    subject: "user-1",
    clientId,
    scope: null,
  });
}

async function withCliHome<T>(callback: () => Promise<T>): Promise<T> {
  const previousCliHome = process.env["CLANKY_CLI_HOME"];
  const cliHome = await mkdtemp(join(tmpdir(), "clanky-cli-auth-"));
  process.env["CLANKY_CLI_HOME"] = cliHome;
  try {
    return await callback();
  } finally {
    if (previousCliHome === undefined) {
      delete process.env["CLANKY_CLI_HOME"];
    } else {
      process.env["CLANKY_CLI_HOME"] = previousCliHome;
    }
    await rm(cliHome, { recursive: true, force: true });
  }
}

function createOutputCapture(): {
  messages: string[];
  out: (message: string) => void;
} {
  const messages: string[] = [];
  return {
    messages,
    out: (message: string) => messages.push(message),
  };
}

const NOW = new Date("2026-07-17T00:00:00.000Z");

describe("CLI authentication", () => {
  test("reports successful environment authentication without exposing the API key", async () => {
    await withCliHome(async () => {
      const apiKey = "env-test-key";
      const { fetchFn, calls } = createFetch(async () => authStatusResponse("api-key"));
      const output = createOutputCapture();

      const exitCode = await runStatusCommand(
        {},
        {
          fetchFn,
          now: () => NOW,
          out: output.out,
          environment: {
            CLANKY_BASE_URL: "https://env.example.test/",
            CLANKY_API_KEY: apiKey,
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(output.messages).toEqual([
        "Authenticated via environment variables at https://env.example.test.",
      ]);
      expect(output.messages.join("\n")).not.toContain(apiKey);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://env.example.test/api/auth/status");
      expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    });
  });

  test("uses an explicit status base URL with the environment API key", async () => {
    await withCliHome(async () => {
      const { fetchFn, calls } = createFetch(async () => authStatusResponse("api-key"));
      const output = createOutputCapture();

      const exitCode = await runStatusCommand(
        { baseUrl: "https://explicit.example.test/" },
        {
          fetchFn,
          now: () => NOW,
          out: output.out,
          environment: {
            CLANKY_API_KEY: "explicit-base-url-key",
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(output.messages[0]).toBe(
        "Authenticated via environment variables at https://explicit.example.test.",
      );
      expect(calls[0]?.url).toBe("https://explicit.example.test/api/auth/status");
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer explicit-base-url-key");
    });
  });

  test("keeps stored device credentials higher priority than environment credentials", async () => {
    await withCliHome(async () => {
      const storedCredentials: StoredCliCredentials = {
        baseUrl: "https://stored.example.test",
        clientId: "stored-client",
        accessToken: "stored-access-token",
        refreshToken: "stored-refresh-token",
        tokenType: "Bearer",
        scope: "",
        accessTokenExpiresAt: "2026-07-18T00:00:00.000Z",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        cookies: "",
      };
      await saveStoredCliCredentials(storedCredentials);

      const { fetchFn, calls } = createFetch(async () => authStatusResponse("bearer", "stored-client"));
      const output = createOutputCapture();

      const exitCode = await runStatusCommand(
        {},
        {
          fetchFn,
          now: () => NOW,
          out: output.out,
          environment: {
            CLANKY_BASE_URL: "https://env.example.test",
            CLANKY_API_KEY: "env-key-that-must-not-win",
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(output.messages).toEqual([
        "Logged in to https://stored.example.test as stored-client.",
      ]);
      expect(calls[0]?.url).toBe("https://stored.example.test/api/auth/status");
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer stored-access-token");
    });
  });

  test("treats a partial environment pair as unauthenticated", async () => {
    await withCliHome(async () => {
      const { fetchFn, calls } = createFetch(async () => authStatusResponse("api-key"));
      const output = createOutputCapture();

      const exitCode = await runStatusCommand(
        {},
        {
          fetchFn,
          now: () => NOW,
          out: output.out,
          environment: {
            CLANKY_BASE_URL: "https://env.example.test",
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(output.messages).toEqual(["Not logged in."]);
      expect(calls).toHaveLength(0);
    });
  });

  test("does not report success when the environment API key is rejected", async () => {
    await withCliHome(async () => {
      const { fetchFn } = createFetch(async () => Response.json(
        {
          error: "invalid_token",
          error_description: "Invalid authentication token",
        },
        { status: 401 },
      ));
      const output = createOutputCapture();

      let error: unknown;
      try {
        await runStatusCommand(
          {},
          {
            fetchFn,
            now: () => NOW,
            out: output.out,
            environment: {
              CLANKY_BASE_URL: "https://env.example.test",
              CLANKY_API_KEY: "rejected-key",
            },
          },
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Invalid authentication token");
      expect(output.messages).toEqual([]);
    });
  });

  test("shares environment authentication with request auth contexts", async () => {
    await withCliHome(async () => {
      const { fetchFn } = createFetch(async () => authStatusResponse("api-key"));
      const context = await getCliRequestAuthContext(
        {},
        {
          fetchFn,
          now: () => NOW,
          environment: {
            CLANKY_BASE_URL: "https://env.example.test",
            CLANKY_API_KEY: "context-key",
          },
        },
      );

      expect(context).toEqual({
        kind: "environment",
        apiKey: "context-key",
        baseUrl: "https://env.example.test",
      });
      if (!context) {
        throw new Error("Expected environment auth context");
      }
      expect(getAuthContextHeaders(context).get("authorization")).toBe("Bearer context-key");
    });
  });
});
