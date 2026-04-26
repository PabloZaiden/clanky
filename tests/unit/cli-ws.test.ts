import { describe, expect, test } from "bun:test";
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
});
