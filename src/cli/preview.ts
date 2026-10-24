import { hostname, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import {
  getAuthorizedHeaders,
  normalizeBaseUrl,
  refreshDeviceCredentials,
  resolveEnvironmentApiKeyAuth,
} from "@pablozaiden/webapp/cli";
import type { CodePreviewOptions, PreviewBridgeClientMessage, PreviewBridgeReadyMessage, PreviewBridgeServerMessage } from "@/shared";
import { PREVIEW_RESPONSE_WINDOW_BYTES, previewWebSocketCloseCode } from "@/shared/preview";
import { getPreviewListenerTls } from "./preview-tls";
import { resolveCliWorkspace, type CliApiAuth, type CliApiContext } from "./remote-api";

const WS_READY_STATE_CLOSING = 2;
const PREVIEW_LISTENER_WS_IDLE_TIMEOUT_SECONDS = 0;

export interface PreviewCommandOptions {
  code?: CodePreviewOptions;
  workspace?: string;
  server?: string;
  port: number;
  remoteHost: string;
  host: string;
  localPort?: number;
  path: string;
  open: boolean;
  https?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  baseUrl?: string;
}

interface PendingPreviewRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  head: boolean;
  body?: ReadableStreamDefaultController<Uint8Array>;
  receivedBytes: number;
  acknowledgedBytes: number;
  cleanup(): void;
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

export interface CliPreviewDependencies extends CliApiContext {
  now?: () => Date;
  out?: (message: string) => void;
  err?: (message: string) => void;
  getHostname?: () => string;
  createSocket?: (url: string, options: { headers: Headers }) => WebSocket;
  serve?: typeof Bun.serve;
  openUrl?: (url: string) => void | Promise<void>;
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
  const flags = new Set<string>();
  const positionals: string[] = [];
  const allowedOptions = new Set([
    "--workspace",
    "--server",
    "--port",
    "--remote-host",
    "--host",
    "--local-port",
    "--path",
    "--base-url",
    "--tls-cert",
    "--tls-key",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : arg.slice(separator + 1);
    if (["--open", "--https"].includes(name)) {
      if (inlineValue !== undefined) throw new Error(`${name} does not take a value`);
      if (flags.has(name)) throw new Error(`${name} may only be specified once`);
      flags.add(name);
      continue;
    }
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
  const server = options["--server"]?.trim();
  if (!workspace && !server) {
    throw new Error("Exactly one target option is required: --workspace or --server");
  }
  if (workspace && server) {
    throw new Error("--workspace and --server may not be used together");
  }
  const rawPort = options["--port"]?.trim();
  if (!rawPort) {
    throw new Error("Missing required option: --port");
  }
  const https = flags.has("--https");
  const tlsCert = options["--tls-cert"];
  const tlsKey = options["--tls-key"];
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error("--tls-cert and --tls-key must be supplied together");
  }
  if (!https && (tlsCert || tlsKey)) {
    throw new Error("--tls-cert and --tls-key require --https");
  }

  const rawBaseUrl = options["--base-url"];
  const baseUrl = rawBaseUrl === undefined ? undefined : normalizeBaseUrl(rawBaseUrl);
  return {
    baseUrl,
    workspace,
    server,
    port: parsePortOption("--port", rawPort),
    remoteHost: options["--remote-host"]?.trim() || "localhost",
    host: options["--host"]?.trim() || "localhost",
    localPort: options["--local-port"]
      ? parsePortOption("--local-port", options["--local-port"])
      : undefined,
    path: normalizePreviewPath(options["--path"] ?? "/"),
    open: flags.has("--open"),
    https,
    tlsCert,
    tlsKey,
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

async function defaultOpenUrl(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Browser launcher timed out"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Browser launcher exited with code ${String(code)}`));
    });
  });
}

function getLanUrls(localUrl: string): string[] {
  const url = new URL(localUrl);
  if (url.hostname !== "0.0.0.0") {
    return [];
  }
  const urls: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        url.hostname = address.address;
        urls.push(url.href);
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

async function waitForReady(socket: WebSocket, timeoutMs: number): Promise<PreviewBridgeReadyMessage> {
  return await new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        return;
      }
      const message = JSON.parse(event.data) as PreviewBridgeServerMessage | { type: "connected" };
      if (message.type === "connected" || message.type === "bridge.ping") {
        return;
      }
      cleanup();
      if (message.type === "ready") {
        resolve(message);
        return;
      }
      reject(new Error(message.type === "stream.error" ? message.error : "Preview bridge did not become ready."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Preview bridge WebSocket failed before ready."));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Preview bridge closed before ready."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Preview startup timed out."));
    }, timeoutMs);
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      clearTimeout(timer);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
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

async function getAuthContext(
  command: PreviewCommandOptions,
  dependencies: CliPreviewDependencies,
): Promise<CliApiAuth | null> {
  const stored = await dependencies.credentials.read();
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
        source: "device",
        accessToken: refreshed.accessToken,
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
      source: "environment",
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
    source: "anonymous",
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
  const workspace = command.workspace
    ? await resolveCliWorkspace(dependencies, authContext, command.workspace)
    : undefined;

  const localPath = normalizePreviewPath(command.path);
  if (command.host === "0.0.0.0") {
    err("Warning: this preview will be exposed to other devices on your local network.");
  }
  const protocol = command.https ? "https" : "http";
  const tls = command.https
    ? await getPreviewListenerTls({ host: command.host, tlsCert: command.tlsCert, tlsKey: command.tlsKey, warn: err })
    : undefined;

  const bridgeUrl = buildPreviewBridgeUrl(authContext.baseUrl);
  const headers = new Headers(authContext.headers);
  headers.set("origin", new URL(authContext.baseUrl).origin);

  const createSocket = dependencies.createSocket ?? createDefaultSocket;
  const socket = createSocket(bridgeUrl, { headers });
  const stopped = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => {
      if (event.code !== 1000) err(event.reason || "Preview bridge disconnected; the preview is no longer available.");
      resolve(event.code === 1000 ? 0 : 1);
    });
    socket.addEventListener("error", () => resolve(1));
  });
  let stopRequested = false;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopListener: () => Promise<void> = async () => {};
  let requestStop = () => closeSocketIfOpen(socket);
  const registerSignalHandler = dependencies.registerSignalHandler ?? registerDefaultSignalHandler;
  const cleanupCallbacks = ["SIGINT", "SIGTERM"].map((signal) =>
    registerSignalHandler(signal as NodeJS.Signals, () => {
      stopRequested = true;
      requestStop();
    }),
  );
  try {
    await waitForSocketOpen(socket);
    const pending = new Map<string, PendingPreviewRequest>();
    const browserSockets = new Map<string, PreviewBrowserSocket>();
    const failActiveStreams = (reason: string) => {
      for (const request of pending.values()) {
        request.body?.error(new Error(reason));
        request.reject(new Error(reason));
        request.cleanup();
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
    const acknowledgeResponse = (streamId: string, request: PendingPreviewRequest) => {
      if (!request.body) return;
      const queuedBytes = PREVIEW_RESPONSE_WINDOW_BYTES - (request.body.desiredSize ?? 0);
      const consumedBytes = request.receivedBytes - queuedBytes;
      const bytes = consumedBytes - request.acknowledgedBytes;
      if (bytes > 0 && sendBridgeMessage({ type: "response.ack", streamId, bytes })) {
        request.acknowledgedBytes = consumedBytes;
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
        browserSocket.close(previewWebSocketCloseCode(message.code), message.reason);
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
        const body = request.head || [204, 205, 304].includes(message.status)
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller: ReadableStreamDefaultController<Uint8Array>) { request.body = controller; },
              pull() { acknowledgeResponse(message.streamId, request); },
              cancel() {
                pending.delete(message.streamId);
                request.cleanup();
                sendBridgeMessage({ type: "request.cancel", streamId: message.streamId });
              },
            }, new ByteLengthQueuingStrategy({ highWaterMark: PREVIEW_RESPONSE_WINDOW_BYTES }));
        request.resolve(new Response(body, { status: message.status, headers: message.headers }));
        return;
      }
      if (message.type === "response.body") {
        const bytes = decodeBase64(message.body);
        request.receivedBytes += bytes.byteLength;
        request.body?.enqueue(bytes);
        acknowledgeResponse(message.streamId, request);
        if (request.body && (request.body.desiredSize ?? 0) < 0) {
          pending.delete(message.streamId);
          const error = new Error("Preview response buffer limit exceeded");
          request.body.error(error);
          request.reject(error);
          request.cleanup();
          sendBridgeMessage({ type: "request.cancel", streamId: message.streamId });
        }
        return;
      }
      if (message.type === "response.end") {
        pending.delete(message.streamId);
        request.body?.close();
        request.cleanup();
        return;
      }
      if (message.type === "stream.error") {
        if (streamId) {
          pending.delete(streamId);
        }
        request.reject(new Error(message.error));
        request.body?.error(new Error(message.error));
        request.cleanup();
      }
    });

    const serve = dependencies.serve ?? Bun.serve;
    const listeners: Bun.Server<PreviewListenerData>[] = [];
    let listenerShutdown: Promise<void> | undefined;
    stopListener = () => listenerShutdown ??= Promise.all(
      listeners.map((listener) => listener.stop(true)),
    ).then(() => undefined);
    const startListener = (host: string, port: number) => serve<PreviewListenerData>({
      hostname: host,
      port,
      tls,
      ipv6Only: host === "::1",
      idleTimeout: 0,
      async fetch(req, server) {
        if (command.code) {
          const url = new URL(req.url);
          const origin = url.origin;
          const allowedOrigins = ["127.0.0.1", "localhost", "[::1]"]
            .map((host) => `http://${host}:${String(server.port)}`);
          const requestOrigin = req.headers.get("origin");
          const crossSite = req.headers.get("sec-fetch-site") === "cross-site";
          const navigation = req.method === "GET" && req.headers.get("sec-fetch-mode") === "navigate";
          if (!allowedOrigins.includes(origin) || (requestOrigin && requestOrigin !== origin) || (crossSite && !navigation)) {
            return new Response("VS Code preview requires its local origin", { status: 403 });
          }
          // VS Code's generated workbench authority cannot parse an IPv6 literal.
          if (url.hostname === "[::1]" && url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
            url.hostname = "localhost";
            return Response.redirect(url.href, 307);
          }
        }
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (browserSockets.size >= 64) return new Response("Too many preview WebSocket connections", { status: 503 });
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
        if (pending.size >= 256) return new Response("Too many active preview requests", { status: 503 });
        const streamId = crypto.randomUUID();
        try {
          const url = new URL(req.url);
          const bodyBytes = req.method === "GET" || req.method === "HEAD"
            ? undefined
            : new Uint8Array(await req.arrayBuffer());
          const responsePromise = new Promise<Response>((resolve, reject) => {
            const abort = () => {
              const request = pending.get(streamId);
              pending.delete(streamId);
              request?.body?.error(new Error("Preview request cancelled"));
              reject(new Error("Preview request cancelled"));
              sendBridgeMessage({ type: "request.cancel", streamId });
            };
            req.signal.addEventListener("abort", abort, { once: true });
            pending.set(streamId, {
              resolve, reject, head: req.method === "HEAD",
              receivedBytes: 0, acknowledgedBytes: 0,
              cleanup: () => req.signal.removeEventListener("abort", abort),
            });
          });
          const sent = sendBridgeMessage({
            type: "request.start",
            streamId,
            method: req.method,
            path: `${url.pathname}${url.search}`,
            headers: Array.from(req.headers.entries()),
            body: bodyBytes ? encodeBase64(bodyBytes) : undefined,
            responseFlowControl: true,
          });
          if (!sent) {
            pending.get(streamId)?.cleanup();
            pending.delete(streamId);
            return createPreviewBridgeFailureResponse("Preview bridge is not connected");
          }
          return await responsePromise;
        } catch (error) {
          pending.get(streamId)?.cleanup();
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

    let server: Bun.Server<PreviewListenerData>;
    try {
      server = startListener(command.host, command.localPort ?? command.port);
    } catch (error) {
      if (
        command.localPort !== undefined
        || command.code
        || !(error instanceof Error)
        || !("code" in error)
        || (error.code !== "EADDRINUSE" && error.code !== "EACCES" && error.code !== "EPERM")
      ) throw error;
      err(`Local port ${String(command.port)} is unavailable (${error.code}); using a random local port.`);
      server = startListener(command.host, 0);
    }
    listeners.push(server);
    if (command.code) {
      try {
        listeners.push(startListener("::1", server.port!));
      } catch (error) {
        if (
          !(error instanceof Error)
          || !("code" in error)
          || (error.code !== "EAFNOSUPPORT" && error.code !== "EADDRNOTAVAIL" && error.code !== "EPROTONOSUPPORT")
        ) throw error;
        err(`IPv6 loopback is unavailable; this preview is listening on IPv4 only: ${String(error)}`);
      }
    }
    requestStop = () => {
      void stopListener().catch((error: unknown) => {
        err(`Unable to close preview listeners: ${String(error)}`);
        socket.close(1011, "Preview listener shutdown failed");
      });
      if (stopTimer) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "close" } satisfies PreviewBridgeClientMessage));
        stopTimer = setTimeout(() => {
          err("Preview shutdown timed out; remote process cleanup could not be confirmed.");
          socket.close(1011, "Preview shutdown timed out");
        }, 10_000);
      } else {
        closeSocketIfOpen(socket);
      }
    };
    if (stopRequested) {
      requestStop();
      return await stopped;
    }

    const serverPort = server.port;
    if (!serverPort) {
      throw new Error("Preview listener did not expose a local port");
    }
    const localHost = command.host.includes(":") && !command.host.startsWith("[")
      ? `[${command.host}]` : command.host;
    const actualLocalUrl = `${protocol}://${localHost}:${String(serverPort)}${localPath}`;
    const readyPromise = waitForReady(socket, command.code ? 130_000 : 30_000);
    socket.send(JSON.stringify({
      type: "hello",
      ...(command.code ? { code: command.code } : {}),
      target: command.server
        ? { kind: "server", reference: command.server }
        : { kind: "workspace", reference: workspace!.id },
      remoteHost: command.remoteHost,
      remotePort: command.port,
      protocol,
      localHost: command.host,
      localPort: serverPort,
      localUrl: actualLocalUrl,
      initialPath: localPath,
      cliHostname: (dependencies.getHostname ?? hostname)(),
    } satisfies PreviewBridgeClientMessage));

    const ready = await readyPromise;
    out(`${command.code ? "VS Code" : "Preview"} ready: ${actualLocalUrl}`);
    if (command.code) out(`Localhost URL: http://localhost:${String(serverPort)}/`);
    if (ready.code) out(`Directory: ${ready.code.directory}`);
    const targetLabel = command.server
      ? `server ${command.server}`
      : `workspace ${command.workspace}`;
    out(`Remote target: ${command.https ? "https://" : ""}${command.remoteHost}:${String(ready.code?.remotePort ?? command.port)} (${targetLabel})`);
    for (const lanUrl of getLanUrls(actualLocalUrl)) {
      out(`LAN URL: ${lanUrl}`);
    }
    if (command.open) {
      try {
        await (dependencies.openUrl ?? defaultOpenUrl)(actualLocalUrl);
      } catch (error) {
        err(`Unable to open the browser: ${String(error)}. Open the URL above manually.`);
      }
    }

    return await stopped;
  } catch (error) {
    if (stopRequested) return await stopped;
    throw error;
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    closeSocketIfOpen(socket);
    for (const cleanup of cleanupCallbacks) cleanup();
    await stopListener();
  }
}
