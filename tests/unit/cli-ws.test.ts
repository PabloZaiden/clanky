import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildWebSocketUrl,
  connectWsCommand,
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
    cliHomeDir = await mkdtemp(join(tmpdir(), "clanky-cli-ws-home-"));
    originalCliHome = process.env["CLANKY_CLI_HOME"];
    process.env["CLANKY_CLI_HOME"] = cliHomeDir;
  });

  afterEach(async () => {
    if (originalCliHome === undefined) {
      delete process.env["CLANKY_CLI_HOME"];
    } else {
      process.env["CLANKY_CLI_HOME"] = originalCliHome;
    }
    await rm(cliHomeDir, { recursive: true, force: true });
  });

  test("buildWebSocketUrl converts http urls and preserves filters", () => {
    expect(buildWebSocketUrl("http://example.test/base", {
      baseUrl: "http://example.test/base",
      taskId: "task-1",
      chatId: "chat-2",
      sshSessionId: "ssh-3",
      sshServerSessionId: "ssh-server-4",
      provisioningJobId: "job-5",
    })).toBe(
      "ws://example.test/base/api/ws?taskId=task-1&chatId=chat-2&sshSessionId=ssh-3&sshServerSessionId=ssh-server-4&provisioningJobId=job-5",
    );
  });

  test("connectWsCommand reuses stored auth headers for the websocket handshake", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "https://example.test/app",
      clientId: "clanky-cli",
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
      taskId: "task-1",
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
    expect(capturedUrl).toBe("wss://example.test/app/api/ws?taskId=task-1");
    expect(capturedHeaders).toBeInstanceOf(Headers);
    expect((capturedHeaders as Headers).get("authorization")).toBe("Bearer access-token-1");
    expect((capturedHeaders as Headers).get("cookie")).toBe("authentik_proxy=proxy-cookie");
    expect((capturedHeaders as Headers).get("origin")).toBe("https://example.test");
  });

  test("connectWsCommand connects anonymously to eligible localhost server", async () => {
    const socket = new FakeWebSocket();
    const requests: string[] = [];
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;

    const connection = await connectWsCommand({
      taskId: "task-1",
    }, createWsDependencies({
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        requests.push(String(input));
        if (String(input) === "http://localhost:3000/api/auth/status") {
          return jsonResponse(200, {
            authenticated: true,
            authKind: "anonymous",
            subject: null,
            clientId: null,
            scope: null,
          });
        }
        throw new Error(`Unexpected fetch to ${String(input)}`);
      }),
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

    expect(connection).not.toBeNull();
    expect(connection?.authContext.kind).toBe("anonymous-local");
    expect(requests).toEqual(["http://localhost:3000/api/auth/status"]);
    expect(capturedUrl).toBe("ws://localhost:3000/api/ws?taskId=task-1");
    expect(capturedHeaders).toBeInstanceOf(Headers);
    expect((capturedHeaders as Headers).get("authorization")).toBeNull();
    expect((capturedHeaders as Headers).get("origin")).toBe("http://localhost:3000");
  });

  test("connectWsCommand does not probe non-localhost anonymous mode without credentials", async () => {
    const stderr: string[] = [];
    let fetchCalled = false;
    let socketCreated = false;

    const connection = await connectWsCommand({
      baseUrl: "http://example.test",
    }, createWsDependencies({
      err: (message: string) => stderr.push(message),
      fetchFn: createFetchMock(async () => {
        fetchCalled = true;
        throw new Error("non-localhost anonymous auth should not be probed");
      }),
      createSocket: () => {
        socketCreated = true;
        return new FakeWebSocket();
      },
    }));

    expect(connection).toBeNull();
    expect(fetchCalled).toBe(false);
    expect(socketCreated).toBe(false);
    expect(stderr).toEqual(["Not logged in."]);
  });

  test("connectWsCommand does not connect anonymously when localhost requires auth", async () => {
    const stderr: string[] = [];
    let socketCreated = false;

    const connection = await connectWsCommand({
      baseUrl: "http://127.0.0.1:3000",
    }, createWsDependencies({
      err: (message: string) => stderr.push(message),
      fetchFn: createFetchMock(async (input: string | URL | Request) => {
        if (String(input) === "http://127.0.0.1:3000/api/auth/status") {
          return jsonResponse(401, {
            error: "authentication_required",
            message: "Passkey authentication is required",
          });
        }
        throw new Error(`Unexpected fetch to ${String(input)}`);
      }),
      createSocket: () => {
        socketCreated = true;
        return new FakeWebSocket();
      },
    }));

    expect(connection).toBeNull();
    expect(socketCreated).toBe(false);
    expect(stderr).toEqual(["Not logged in."]);
  });

  test("runWsCommand bridges stdout payloads and stdin websocket messages", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "clanky-cli",
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
      socket.emit("message", { data: JSON.stringify({ type: "connected", taskId: "task-1" }) });
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCodePromise = runWsCommand({
      taskId: "task-1",
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
    expect(stdout).toEqual([JSON.stringify({ type: "connected", taskId: "task-1" })]);
    expect(stderr).toEqual([]);
    expect(socket.closeCode).toBe(1000);
    expect(socket.closeReason).toBe("stdin EOF");
  });

  test("runWsCommand rejects invalid stdin JSON without corrupting stdout", async () => {
    const credentials: StoredCliCredentials = {
      baseUrl: "http://example.test",
      clientId: "clanky-cli",
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
      clientId: "clanky-cli",
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
      clientId: "clanky-cli",
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
