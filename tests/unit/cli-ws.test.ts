import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildWebSocketUrl,
  connectWsCommand,
  loadStoredCliCredentials,
  runWsCommand,
  saveStoredCliCredentials,
  type CliWebSocketLike,
  type CliWsDependencies,
  type StoredCliCredentials,
} from "../../src/cli";

type SocketListenerMap = Map<string, Set<(event?: unknown) => void>>;

class FakeWebSocket implements CliWebSocketLike {
  public readyState = 0;
  public readonly listeners: SocketListenerMap = new Map();
  public readonly sentMessages: string[] = [];
  public closeCode?: number;
  public closeReason?: string;

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", {
      code,
      reason,
      wasClean: true,
    });
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

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

function createInputLines(lines: string[]): AsyncIterable<string> & { close: () => void } {
  let closed = false;

  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        if (closed) {
          return;
        }
        yield line;
      }
    },
    close() {
      closed = true;
    },
  };
}

function createBlockingInputLines(): AsyncIterable<string> & { close: () => void } {
  let closed = false;
  let resolvePending: (() => void) | null = null;

  return {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        await new Promise<void>((resolve) => {
          resolvePending = resolve;
        });
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      resolvePending?.();
      resolvePending = null;
    },
  };
}

function createWsDependencies(
  overrides: Partial<CliWsDependencies> = {},
): CliWsDependencies {
  return {
    fetchFn: createFetchMock(async () => new Response(null, { status: 500 })),
    now: () => new Date("2026-04-21T17:15:00.000Z"),
    ...overrides,
  };
}

describe("cli websocket helpers", () => {
  let cliHomeDir: string;
  let originalCliHome: string | undefined;

  beforeEach(async () => {
    cliHomeDir = await mkdtemp(join(tmpdir(), "ralpher-cli-ws-home-"));
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

  test("buildWebSocketUrl converts http urls and preserves filters", () => {
    expect(buildWebSocketUrl("http://example.test/base", {
      baseUrl: "http://example.test/base",
      loopId: "loop-1",
      chatId: "chat-2",
      sshSessionId: "ssh-3",
      sshServerSessionId: "ssh-server-4",
      provisioningJobId: "job-5",
    })).toBe(
      "ws://example.test/base/api/ws?loopId=loop-1&chatId=chat-2&sshSessionId=ssh-3&sshServerSessionId=ssh-server-4&provisioningJobId=job-5",
    );
  });

  test("connectWsCommand reuses stored auth headers for the websocket handshake", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "https://example.test/app",
      clientId: "ralpher-cli",
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    };
    await saveStoredCliCredentials(credentials);

    const socket = new FakeWebSocket();
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const connectPromise = connectWsCommand({
      loopId: "loop-1",
    }, createWsDependencies({
      createSocket: (url, options) => {
        capturedUrl = url;
        capturedHeaders = options.headers;
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    const connection = await connectPromise;

    expect(connection).not.toBeNull();
    expect(capturedUrl).toBe("wss://example.test/app/api/ws?loopId=loop-1");
    expect(capturedHeaders).toBeInstanceOf(Headers);
    expect((capturedHeaders as Headers).get("authorization")).toBe("Bearer access-token-1");
    expect((capturedHeaders as Headers).get("cookie")).toBe("authentik_proxy=proxy-cookie");
    expect((capturedHeaders as Headers).get("origin")).toBe("https://example.test");
  });

  test("connectWsCommand refreshes provided credentials in memory without rewriting cli-auth.json", async () => {
    const expiredCredentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      tokenType: "Bearer",
      scope: "",
      cookies: "authentik_proxy=proxy-cookie",
      accessTokenExpiresAt: "2026-04-21T17:14:59.000Z",
      createdAt: "2026-04-21T17:00:00.000Z",
      updatedAt: "2026-04-21T17:00:00.000Z",
    };
    await saveStoredCliCredentials(expiredCredentials);

    const requests: Array<{
      url: string;
      cookie?: string | null;
      origin?: string | null;
    }> = [];
    const socket = new FakeWebSocket();
    let capturedHeaders: HeadersInit | undefined;

    const connection = await connectWsCommand({
      loopId: "loop-1",
    }, createWsDependencies({
      credentials: expiredCredentials,
      persistCredentials: false,
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
      createSocket: (_url, options) => {
        capturedHeaders = options.headers;
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    expect(connection).not.toBeNull();
    if (!capturedHeaders) {
      throw new Error("Expected websocket handshake headers to be captured.");
    }
    const handshakeHeaders = new Headers(capturedHeaders);
    expect(handshakeHeaders.get("authorization")).toBe("Bearer fresh-access");
    expect(handshakeHeaders.get("cookie")).toBe("authentik_proxy=proxy-cookie");
    expect(requests).toEqual([
      {
        url: "http://example.test/api/auth/token",
        cookie: "authentik_proxy=proxy-cookie",
        origin: "http://example.test",
      },
    ]);
    expect(await loadStoredCliCredentials()).toEqual(expiredCredentials);

    connection?.socket.close(1000, "test complete");
  });

  test("runWsCommand bridges stdout payloads and stdin websocket messages", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "access-token-2",
      refreshToken: "refresh-token-2",
      tokenType: "Bearer",
      scope: "",
      cookies: "",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    };
    await saveStoredCliCredentials(credentials);

    const socket = new FakeWebSocket();
    socket.send = (data: string) => {
      socket.sentMessages.push(data);
      socket.emit("message", { data: JSON.stringify({ type: "connected", loopId: "loop-1" }) });
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCodePromise = runWsCommand({
      loopId: "loop-1",
    }, createWsDependencies({
      out: (message: string) => stdout.push(message),
      err: (message: string) => stderr.push(message),
      inputLines: createInputLines([
        JSON.stringify({ type: "ping" }),
      ]),
      registerSignalHandler: () => () => {},
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    const exitCode = await exitCodePromise;

    expect(exitCode).toBe(0);
    expect(socket.sentMessages).toEqual([JSON.stringify({ type: "ping" })]);
    expect(stdout).toEqual([JSON.stringify({ type: "connected", loopId: "loop-1" })]);
    expect(stderr).toEqual([]);
    expect(socket.closeCode).toBe(1000);
    expect(socket.closeReason).toBe("stdin EOF");
  });

  test("runWsCommand rejects invalid stdin JSON without corrupting stdout", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "access-token-3",
      refreshToken: "refresh-token-3",
      tokenType: "Bearer",
      scope: "",
      cookies: "",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    };
    await saveStoredCliCredentials(credentials);

    const socket = new FakeWebSocket();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runWsCommand({}, createWsDependencies({
      out: (message: string) => stdout.push(message),
      err: (message: string) => stderr.push(message),
      inputLines: createInputLines(["not-json"]),
      registerSignalHandler: () => () => {},
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Error: stdin must contain one valid JSON value per non-empty line."]);
    expect(socket.closeCode).toBe(1000);
    expect(socket.closeReason).toBe("stdin failure");
  });

  test("runWsCommand reports websocket errors before the close result", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "access-token-4",
      refreshToken: "refresh-token-4",
      tokenType: "Bearer",
      scope: "",
      cookies: "",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    };
    await saveStoredCliCredentials(credentials);

    const socket = new FakeWebSocket();
    const originalAddEventListener = socket.addEventListener.bind(socket);
    socket.addEventListener = (type: string, listener: (event?: unknown) => void) => {
      originalAddEventListener(type, listener);
      if (type === "error" && (socket.listeners.get("message")?.size ?? 0) > 0) {
        queueMicrotask(() => {
          socket.emit("error");
          socket.readyState = 3;
          socket.emit("close", {
            code: 1000,
            reason: "server ended after error",
            wasClean: true,
          });
        });
      }
    };

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runWsCommand({}, createWsDependencies({
      out: (message: string) => stdout.push(message),
      err: (message: string) => stderr.push(message),
      inputLines: createBlockingInputLines(),
      registerSignalHandler: () => () => {},
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["WebSocket connection error."]);
  });

  test("runWsCommand reports unexpected websocket closes from the server", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "ralpher-cli",
      accessToken: "access-token-5",
      refreshToken: "refresh-token-5",
      tokenType: "Bearer",
      scope: "",
      cookies: "",
      accessTokenExpiresAt: "2026-04-21T17:25:00.000Z",
      createdAt: "2026-04-21T17:15:00.000Z",
      updatedAt: "2026-04-21T17:15:00.000Z",
    };
    await saveStoredCliCredentials(credentials);

    const socket = new FakeWebSocket();
    const originalAddEventListener = socket.addEventListener.bind(socket);
    socket.addEventListener = (type: string, listener: (event?: unknown) => void) => {
      originalAddEventListener(type, listener);
      if (type === "message") {
        queueMicrotask(() => {
          socket.readyState = 3;
          socket.emit("close", {
            code: 1011,
            reason: "server failure",
            wasClean: false,
          });
        });
      }
    };

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runWsCommand({}, createWsDependencies({
      out: (message: string) => stdout.push(message),
      err: (message: string) => stderr.push(message),
      inputLines: createBlockingInputLines(),
      registerSignalHandler: () => () => {},
      createSocket: () => {
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    }));

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["WebSocket closed unexpectedly (code 1011: server failure)."]);
  });
});
