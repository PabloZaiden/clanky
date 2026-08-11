import { hostname, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import {
  getAuthorizedHeaders,
  normalizeBaseUrl,
  refreshDeviceCredentials,
  resolveEnvironmentApiKeyAuth,
  type CliEnvironment,
  type DeviceCredentialsStore,
  type StoredDeviceCredentials,
} from "@pablozaiden/webapp/cli";
import type { PreviewBridgeClientMessage, PreviewBridgeReadyMessage, PreviewBridgeServerMessage } from "@/shared";

const WS_READY_STATE_CLOSING = 2;
const PREVIEW_LISTENER_WS_IDLE_TIMEOUT_SECONDS = 0;

export interface PreviewCommandOptions {
  workspace: string;
  port: number;
  remoteHost: string;
  host: string;
  localPort?: number;
  path: string;
  open: boolean;
  baseUrl?: string;
}

interface PendingPreviewRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  status?: number;
  headers?: Array<[string, string]>;
  chunks: Uint8Array[];
}

interface PreviewBrowserSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface PreviewListenerData {
  headers: Array<[string, string]>;
  path: string;
  streamId: string;
}

export interface CliPreviewDependencies {
  fetchFn: typeof fetch;
  now?: () => Date;
  envPrefix?: string;
  environment?: CliEnvironment;
  credentials?: DeviceCredentialsStore & {
    read(): Promise<StoredDeviceCredentials | undefined>;
  };
  out?: (message: string) => void;
  err?: (message: string) => void;
  getHostname?: () => string;
  createSocket?: (url: string, options: { headers: Headers }) => WebSocket;
  serve?: typeof Bun.serve;
  openUrl?: (url: string) => void;
  registerSignalHandler?: (signal: NodeJS.Signals, handler: () => void) => () => void;
}

const DEFAULT_LOCAL_BASE_URL = "http://localhost:3000";

function normalizePreviewPath(value: string): string {
  const trimmed = value.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseOptionValue(
  args: readonly string[],
  index: number,
  name: string,
  inlineValue?: string,
): { value: string; nextIndex: number } {
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return {
    value,
    nextIndex: inlineValue === undefined ? index + 1 : index,
  };
}

function parsePortOption(name: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function parsePreviewCommandArgs(args: readonly string[]): PreviewCommandOptions {
  const options: Record<string, string> = {};
  let open = false;
  const positionals: string[] = [];
  const allowedOptions = new Set([
    "--workspace",
    "--port",
    "--remote-host",
    "--host",
    "--local-port",
    "--path",
    "--base-url",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--open") {
      if (open) {
        throw new Error("--open may only be specified once");
      }
      open = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.split("=", 2);
    const name = rawName ?? arg;
    if (!allowedOptions.has(name)) {
      throw new Error(`Unknown preview option: ${name}`);
    }
    if (options[name] !== undefined) {
      throw new Error(`${name} may only be specified once`);
    }
    const parsed = parseOptionValue(args, index, name, inlineValue);
    options[name] = parsed.value;
    index = parsed.nextIndex;
  }

  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }

  const workspace = options["--workspace"]?.trim();
  if (!workspace) {
    throw new Error("Missing required option: --workspace");
  }
  const rawPort = options["--port"]?.trim();
  if (!rawPort) {
    throw new Error("Missing required option: --port");
  }

  const rawBaseUrl = options["--base-url"];
  const baseUrl = rawBaseUrl === undefined ? undefined : normalizeBaseUrl(rawBaseUrl);
  return {
    baseUrl,
    workspace,
    port: parsePortOption("--port", rawPort),
    remoteHost: options["--remote-host"]?.trim() || "localhost",
    host: options["--host"]?.trim() || "localhost",
    localPort: options["--local-port"]
      ? parsePortOption("--local-port", options["--local-port"])
      : undefined,
    path: normalizePreviewPath(options["--path"] ?? "/"),
    open,
  };
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function buildPreviewBridgeUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/api/previews/bridge`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createDefaultSocket(url: string, options: { headers: Headers }): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  };
  return new BunWebSocket(url, {
    headers: Object.fromEntries(options.headers.entries()),
  });
}

function registerDefaultSignalHandler(signal: NodeJS.Signals, handler: () => void): () => void {
  process.on(signal, handler);
  return () => process.off(signal, handler);
}

function defaultOpenUrl(url: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

function getLanUrls(host: string, port: number, path: string): string[] {
  if (host !== "0.0.0.0") {
    return [];
  }
  const urls: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${String(port)}${path}`);
      }
    }
  }
  return urls;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Preview bridge WebSocket connection failed."));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Preview bridge WebSocket closed before it was ready."));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function waitForReady(socket: WebSocket): Promise<PreviewBridgeReadyMessage> {
  return await new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = JSON.parse(event.data) as PreviewBridgeServerMessage | { type: "connected" };
      if (message.type === "connected") {
        return;
      }
      cleanup();
      if (message.type === "ready") {
        resolve(message);
        return;
      }
      reject(new Error("Preview bridge did not become ready."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Preview bridge WebSocket failed before ready."));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function closeSocketIfOpen(socket: WebSocket): void {
  if (socket.readyState < WS_READY_STATE_CLOSING) {
    socket.close(1000, "Preview command stopped");
  }
}

function createPreviewBridgeFailureResponse(error: unknown): Response {
  return new Response(`Preview bridge request failed: ${String(error)}`, { status: 502 });
}

interface PreviewAuthContext {
  baseUrl: string;
  headers: Headers;
}

async function getAuthContext(
  command: PreviewCommandOptions,
  dependencies: CliPreviewDependencies,
): Promise<PreviewAuthContext | null> {
  const stored = await dependencies.credentials?.read();
  if (stored) {
    const refreshed = await refreshDeviceCredentials({
      credentials: stored,
      store: dependencies.credentials,
      fetchFn: dependencies.fetchFn,
      now: dependencies.now,
    });
    if (refreshed) {
      return {
        baseUrl: refreshed.baseUrl,
        headers: getAuthorizedHeaders(refreshed),
      };
    }
  }

  const environmentAuth = dependencies.envPrefix
    ? resolveEnvironmentApiKeyAuth({
      envPrefix: dependencies.envPrefix,
      explicitBaseUrl: command.baseUrl,
      environment: dependencies.environment,
    })
    : undefined;
  if (environmentAuth) {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${environmentAuth.apiKey}`);
    return {
      baseUrl: environmentAuth.baseUrl,
      headers,
    };
  }

  const anonymousHeaders = new Headers();
  const environmentBaseUrl = dependencies.envPrefix
    ? dependencies.environment?.[`${dependencies.envPrefix}_BASE_URL`]
    : undefined;
  const rawBaseUrl = command.baseUrl ?? environmentBaseUrl ?? DEFAULT_LOCAL_BASE_URL;
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  } catch {
    return null;
  }
  const response = await dependencies.fetchFn(`${baseUrl}/api/auth/status`, {
    headers: anonymousHeaders,
  });
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (
    !body
    || typeof body !== "object"
    || (body as Record<string, unknown>)["authKind"] !== "anonymous"
  ) {
    return null;
  }
  return {
    baseUrl,
    headers: anonymousHeaders,
  };
}

export async function runPreviewCommand(
  command: PreviewCommandOptions,
  dependencies: CliPreviewDependencies,
): Promise<number> {
  const out = dependencies.out ?? console.log;
  const err = dependencies.err ?? console.error;
  const authContext = await getAuthContext(command, dependencies);
  if (!authContext) {
    err("Not logged in.");
    return 1;
  }

  const localPath = normalizePreviewPath(command.path);
  if (command.host === "0.0.0.0") {
    err("Warning: this preview will be exposed to other devices on your local network.");
  }

  const bridgeUrl = buildPreviewBridgeUrl(authContext.baseUrl);
  const headers = new Headers(authContext.headers);
  headers.set("origin", new URL(authContext.baseUrl).origin);

  const createSocket = dependencies.createSocket ?? createDefaultSocket;
  const socket = createSocket(bridgeUrl, { headers });
  await waitForSocketOpen(socket);
  const pending = new Map<string, PendingPreviewRequest>();
  const browserSockets = new Map<string, PreviewBrowserSocket>();
  const failActiveStreams = (reason: string) => {
    for (const request of pending.values()) {
      request.reject(new Error(reason));
    }
    pending.clear();
    for (const browserSocket of browserSockets.values()) {
      browserSocket.close(1011, reason);
    }
    browserSockets.clear();
  };
  const sendBridgeMessage = (message: PreviewBridgeClientMessage): boolean => {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  socket.addEventListener("close", () => failActiveStreams("Preview bridge closed"));
  socket.addEventListener("error", () => failActiveStreams("Preview bridge failed"));
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = JSON.parse(event.data) as PreviewBridgeServerMessage | { type: "connected" };
    if (message.type === "connected" || message.type === "ready" || message.type === "bridge.ping") {
      if (message.type === "bridge.ping") {
        sendBridgeMessage({ type: "bridge.pong" });
      }
      return;
    }
    const streamId = "streamId" in message && typeof message.streamId === "string" ? message.streamId : undefined;
    const browserSocket = streamId ? browserSockets.get(streamId) : undefined;
    if (message.type === "websocket.message" && browserSocket) {
      const payload = decodeBase64(message.body);
      browserSocket.send(message.binary ? payload : new TextDecoder().decode(payload));
      return;
    }
    if (message.type === "websocket.close" && streamId && browserSocket) {
      browserSockets.delete(streamId);
      browserSocket.close(message.code, message.reason);
      return;
    }
    if (message.type === "stream.error" && streamId && browserSocket) {
      browserSockets.delete(streamId);
      browserSocket.close(1011, message.error);
      return;
    }
    const request = streamId ? pending.get(streamId) : undefined;
    if (!request) {
      return;
    }
    if (message.type === "response.start") {
      request.status = message.status;
      request.headers = message.headers;
      return;
    }
    if (message.type === "response.body") {
      request.chunks.push(decodeBase64(message.body));
      return;
    }
    if (message.type === "response.end") {
      pending.delete(message.streamId);
      request.resolve(new Response(Buffer.concat(request.chunks.map((chunk) => Buffer.from(chunk))), {
        status: request.status ?? 502,
        headers: request.headers,
      }));
      return;
    }
    if (message.type === "stream.error") {
      if (streamId) {
        pending.delete(streamId);
      }
      request.reject(new Error(message.error));
    }
  });

  const serve = dependencies.serve ?? Bun.serve;
  const server = serve<PreviewListenerData>({
    hostname: command.host,
    port: command.localPort ?? 0,
    async fetch(req) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const streamId = crypto.randomUUID();
        try {
          const url = new URL(req.url);
          const upgraded = server.upgrade(req, {
            data: {
              headers: Array.from(req.headers.entries()),
              path: `${url.pathname}${url.search}`,
              streamId,
            },
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return;
        } catch (error) {
          return createPreviewBridgeFailureResponse(error);
        }
      }
      const streamId = crypto.randomUUID();
      try {
        const url = new URL(req.url);
        const bodyBytes = req.method === "GET" || req.method === "HEAD"
          ? undefined
          : new Uint8Array(await req.arrayBuffer());
        const responsePromise = new Promise<Response>((resolve, reject) => {
          pending.set(streamId, { resolve, reject, chunks: [] });
        });
        const sent = sendBridgeMessage({
          type: "request.start",
          streamId,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers: Array.from(req.headers.entries()),
          body: bodyBytes ? encodeBase64(bodyBytes) : undefined,
        });
        if (!sent) {
          pending.delete(streamId);
          return createPreviewBridgeFailureResponse("Preview bridge is not connected");
        }
        return await responsePromise;
      } catch (error) {
        pending.delete(streamId);
        return createPreviewBridgeFailureResponse(error);
      }
    },
    websocket: {
      idleTimeout: PREVIEW_LISTENER_WS_IDLE_TIMEOUT_SECONDS,
      open(ws) {
        const { headers, path, streamId } = ws.data;
        browserSockets.set(streamId, ws);
        const sent = sendBridgeMessage({
          type: "websocket.open",
          streamId,
          path,
          headers,
        });
        if (!sent) {
          browserSockets.delete(streamId);
          ws.close(1011, "Preview bridge is not connected");
        }
      },
      message(ws, data) {
        const { streamId } = ws.data;
        const body = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data instanceof Buffer
            ? new Uint8Array(data)
            : data;
        const sent = sendBridgeMessage({
          type: "websocket.message",
          streamId,
          body: encodeBase64(body),
          binary: typeof data !== "string",
        });
        if (!sent) {
          browserSockets.delete(streamId);
          ws.close(1011, "Preview bridge is not connected");
        }
      },
      close(ws, code, reason) {
        const { streamId } = ws.data;
        browserSockets.delete(streamId);
        sendBridgeMessage({
          type: "websocket.close",
          streamId,
          code,
          reason,
        });
      },
    },
  });

  const serverPort = server.port;
  if (!serverPort) {
    throw new Error("Preview listener did not expose a local port");
  }
  const actualLocalUrl = `http://${command.host}:${String(serverPort)}${localPath}`;
  socket.send(JSON.stringify({
    type: "hello",
    workspace: command.workspace,
    remoteHost: command.remoteHost,
    remotePort: command.port,
    localHost: command.host,
    localPort: serverPort,
    localUrl: actualLocalUrl,
    initialPath: localPath,
    cliHostname: (dependencies.getHostname ?? hostname)(),
  } satisfies PreviewBridgeClientMessage));

  const ready = await waitForReady(socket);
  out(`Preview ready: ${actualLocalUrl}`);
  out(`Remote target: ${command.remoteHost}:${String(command.port)} (${ready.workspaceId})`);
  for (const lanUrl of getLanUrls(command.host, serverPort, localPath)) {
    out(`LAN URL: ${lanUrl}`);
  }
  if (command.open) {
    (dependencies.openUrl ?? defaultOpenUrl)(actualLocalUrl);
  }

  const registerSignalHandler = dependencies.registerSignalHandler ?? registerDefaultSignalHandler;
  const cleanupCallbacks = [
    registerSignalHandler("SIGINT", () => {
      closeSocketIfOpen(socket);
      server.stop(true);
    }),
    registerSignalHandler("SIGTERM", () => {
      closeSocketIfOpen(socket);
      server.stop(true);
    }),
  ];

  const result = await new Promise<number>((resolve) => {
    socket.addEventListener("close", () => resolve(0));
    socket.addEventListener("error", () => resolve(1));
  });
  server.stop(true);
  for (const cleanup of cleanupCallbacks) {
    cleanup();
  }
  return result;
}
