import { createInterface } from "node:readline";
import {
  getAuthorizedHeaders,
  getCliRequestAuthContext,
  type CliRequestAuthContext,
  type StatusCommandOptions,
} from "./cli-auth";

const WS_READY_STATE_CLOSING = 2;
const NORMAL_CLOSE_CODES = new Set([1000, 1001]);

type CliWebSocketEventType = "open" | "message" | "close" | "error";
type CliWebSocketListener = (event?: unknown) => void;

type ClosableAsyncIterable<T> = AsyncIterable<T> & {
  close?: () => void;
};

export interface WsCommandOptions extends StatusCommandOptions {
  taskId?: string;
  chatId?: string;
  sshSessionId?: string;
  sshServerSessionId?: string;
  provisioningJobId?: string;
}

export interface CliWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: CliWebSocketEventType, listener: CliWebSocketListener): void;
  removeEventListener(type: CliWebSocketEventType, listener: CliWebSocketListener): void;
}

export interface CliWsCloseEvent {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface CliWsMessageEvent {
  data?: unknown;
}

export interface CliWsCloseResult {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface CliWsConnection {
  authContext: CliRequestAuthContext;
  socket: CliWebSocketLike;
  url: string;
  closePromise: Promise<CliWsCloseResult>;
}

export interface CliWsDependencies {
  fetchFn: typeof fetch;
  now: () => Date;
  out?: (message: string) => void;
  err?: (message: string) => void;
  createSocket?: (url: string, options: { headers: Headers }) => CliWebSocketLike;
  inputLines?: ClosableAsyncIterable<string>;
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => void) => () => void;
}

function createDefaultSocket(url: string, options: { headers: Headers }): CliWebSocketLike {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  };

  return new BunWebSocket(url, {
    headers: Object.fromEntries(options.headers.entries()),
  }) as unknown as CliWebSocketLike;
}

function createDefaultInputLines(): ClosableAsyncIterable<string> {
  return createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
}

function registerDefaultSignalHandler(signal: NodeJS.Signals, handler: () => void): () => void {
  process.on(signal, handler);
  return () => process.off(signal, handler);
}

function readCloseEvent(event?: unknown): CliWsCloseResult {
  const closeEvent = (event ?? {}) as CliWsCloseEvent;
  return {
    code: typeof closeEvent.code === "number" ? closeEvent.code : 1006,
    reason: typeof closeEvent.reason === "string" ? closeEvent.reason : "",
    wasClean: closeEvent.wasClean ?? false,
  };
}

function isNormalClose(result: CliWsCloseResult): boolean {
  return NORMAL_CLOSE_CODES.has(result.code);
}

function formatCloseSummary(result: CliWsCloseResult): string {
  return result.reason
    ? `code ${String(result.code)}: ${result.reason}`
    : `code ${String(result.code)}`;
}

function createClosePromise(socket: CliWebSocketLike): Promise<CliWsCloseResult> {
  return new Promise((resolve) => {
    const handleClose: CliWebSocketListener = (event?: unknown) => {
      cleanup();
      resolve(readCloseEvent(event));
    };

    const handleError: CliWebSocketListener = () => {
      // Rely on the close event for the final outcome. Most runtimes emit both.
    };

    const cleanup = () => {
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
    };

    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
  });
}

async function waitForSocketOpen(socket: CliWebSocketLike): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleOpen: CliWebSocketListener = () => {
      cleanup();
      resolve();
    };
    const handleError: CliWebSocketListener = () => {
      cleanup();
      reject(new Error("WebSocket connection failed."));
    };
    const handleClose: CliWebSocketListener = (event?: unknown) => {
      cleanup();
      reject(new Error(`WebSocket closed before opening (${formatCloseSummary(readCloseEvent(event))}).`));
    };

    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

function closeInputLines(inputLines: ClosableAsyncIterable<string>): void {
  if (typeof inputLines.close === "function") {
    inputLines.close();
  }
}

function closeSocketIfOpen(socket: CliWebSocketLike, code: number, reason: string): void {
  if (socket.readyState >= WS_READY_STATE_CLOSING) {
    return;
  }
  socket.close(code, reason);
}

function normalizeJsonLine(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }

  try {
    JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("stdin must contain one valid JSON value per non-empty line.");
  }

  return trimmed;
}

export function buildWebSocketUrl(baseUrl: string, command: WsCommandOptions): string {
  const url = new URL(`${baseUrl}/api/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  if (command.taskId) {
    url.searchParams.set("taskId", command.taskId);
  }
  if (command.chatId) {
    url.searchParams.set("chatId", command.chatId);
  }
  if (command.sshSessionId) {
    url.searchParams.set("sshSessionId", command.sshSessionId);
  }
  if (command.sshServerSessionId) {
    url.searchParams.set("sshServerSessionId", command.sshServerSessionId);
  }
  if (command.provisioningJobId) {
    url.searchParams.set("provisioningJobId", command.provisioningJobId);
  }

  return url.toString();
}

export async function connectWsCommand(
  command: WsCommandOptions,
  dependencies: Pick<CliWsDependencies, "createSocket" | "err" | "fetchFn" | "now">,
): Promise<CliWsConnection | null> {
  const err = dependencies.err ?? console.error;
  const authContext = await getCliRequestAuthContext({ baseUrl: command.baseUrl }, dependencies);
  if (!authContext) {
    err("Not logged in.");
    return null;
  }

  const url = buildWebSocketUrl(authContext.baseUrl, command);
  const headers = authContext.kind === "bearer"
    ? getAuthorizedHeaders(authContext.credentials)
    : new Headers();
  headers.set("origin", new URL(authContext.baseUrl).origin);

  const createSocket = dependencies.createSocket ?? createDefaultSocket;
  const socket = createSocket(url, { headers });
  const closePromise = createClosePromise(socket);

  await waitForSocketOpen(socket);

  return {
    authContext,
    socket,
    url,
    closePromise,
  };
}

export async function runWsCommand(
  command: WsCommandOptions,
  dependencies: CliWsDependencies,
): Promise<number> {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const connection = await connectWsCommand(command, dependencies);
  if (!connection) {
    return 1;
  }

  const inputLines = dependencies.inputLines ?? createDefaultInputLines();
  const registerSignalHandler = dependencies.registerSignalHandler ?? registerDefaultSignalHandler;
  const cleanupCallbacks: Array<() => void> = [];
  let localShutdownRequested = false;
  let inputClosedBySocket = false;
  let socketErrorDetected = false;
  let inputFailure: Error | null = null;

  const handleMessage: CliWebSocketListener = (event?: unknown) => {
    const data = (event as CliWsMessageEvent | undefined)?.data;
    if (typeof data !== "string") {
      inputFailure = new Error("Received a non-text websocket message.");
      localShutdownRequested = true;
      closeSocketIfOpen(connection.socket, 1003, "Non-text websocket frame");
      closeInputLines(inputLines);
      return;
    }
    out(data);
  };
  const handleError: CliWebSocketListener = () => {
    socketErrorDetected = true;
  };
  const handleCloseInput = () => {
    inputClosedBySocket = true;
    closeInputLines(inputLines);
  };

  connection.socket.addEventListener("message", handleMessage);
  connection.socket.addEventListener("error", handleError);
  connection.closePromise.finally(handleCloseInput);
  cleanupCallbacks.push(() => connection.socket.removeEventListener("message", handleMessage));
  cleanupCallbacks.push(() => connection.socket.removeEventListener("error", handleError));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    cleanupCallbacks.push(registerSignalHandler(signal, () => {
      localShutdownRequested = true;
      closeSocketIfOpen(connection.socket, 1000, `Received ${signal}`);
      closeInputLines(inputLines);
    }));
  }

  const inputPump = (async () => {
    try {
      for await (const rawLine of inputLines) {
        const message = normalizeJsonLine(rawLine);
        if (!message) {
          continue;
        }
        connection.socket.send(message);
      }

      if (inputClosedBySocket) {
        return;
      }

      localShutdownRequested = true;
      closeSocketIfOpen(connection.socket, 1000, "stdin EOF");
    } catch (error) {
      inputFailure = error instanceof Error ? error : new Error(String(error));
      localShutdownRequested = true;
      closeSocketIfOpen(connection.socket, 1000, "stdin failure");
    } finally {
      closeInputLines(inputLines);
    }
  })();

  const closeResult = await connection.closePromise;
  await inputPump;

  for (const cleanup of cleanupCallbacks) {
    cleanup();
  }

  if (inputFailure) {
    err(String(inputFailure));
    return 1;
  }

  if (!localShutdownRequested && socketErrorDetected) {
    err("WebSocket connection error.");
    return 1;
  }

  if (!localShutdownRequested && !isNormalClose(closeResult)) {
    err(`WebSocket closed unexpectedly (${formatCloseSummary(closeResult)}).`);
    return 1;
  }

  return 0;
}
