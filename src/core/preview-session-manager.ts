/**
 * Core manager for CLI-owned workspace live preview sessions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  type PreviewBridgeClientMessage,
  type PreviewBridgeHelloMessage,
  type PreviewBridgeWebSocketCloseMessage,
  type PreviewBridgeWebSocketMessage,
  type PreviewBridgeWebSocketOpenMessage,
  type PreviewSession,
  type RegisterCliPreviewOptions,
  type Workspace,
} from "../types";
import { getWorkspace, listWorkspaces, touchWorkspace } from "../persistence/workspaces";
import {
  deletePreviewSession,
  getPreviewSession,
  listPreviewSessionsByWorkspaceAndStatuses,
  listPreviewSessionsByStatuses,
  savePreviewSession,
} from "../persistence/preview-sessions";
import { createLogger } from "./logger";
import { previewEventEmitter } from "./event-emitter";
import { ensureLocalPortAvailable } from "./local-port-allocator";
import { buildSshProcessConfig, getSshConnectionTargetFromWorkspace } from "./ssh-connection-target";
import { waitForProcessExit, waitForProcessStartup } from "./process-lifecycle";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";

const log = createLogger("core:preview-session-manager");
const LOCAL_TUNNEL_HOST = "127.0.0.1";
const STARTUP_GRACE_MS = 500;
const STOP_TIMEOUT_MS = 2000;
const WS_READY_STATE_CLOSING = 2;

interface PreviewRuntime {
  localOrigin: string;
  user: CurrentUser;
  targetBaseUrl: string;
  targetOrigin: string;
  tunnel?: ChildProcess;
  tunnelLocalPort?: number;
}

interface PreviewBridgeSocket {
  data: { previewBridgeSessionId?: string; user?: CurrentUser };
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface UpstreamWebSocketState {
  socket: WebSocket;
  queuedMessages: Array<string | ArrayBuffer>;
}

function normalizeInitialPath(value: string): string {
  const trimmed = value.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function createUpstreamWebSocket(url: URL, headers: Record<string, string>): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  };
  return new BunWebSocket(url, { headers });
}

function getHeaderValue(headers: Array<[string, string]>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return headers.find(([candidateName]) => candidateName.toLowerCase() === lowerName)?.[1];
}

function getForwardedOriginParts(headers: Array<[string, string]>, runtime: PreviewRuntime): URL {
  const origin = getHeaderValue(headers, "origin");
  if (origin) {
    try {
      return new URL(origin);
    } catch {
      // Fall back to the registered preview URL if a non-browser client sent an invalid Origin.
    }
  }
  return new URL(runtime.localOrigin);
}

function getForwardedPort(origin: URL): string | undefined {
  if (origin.port) {
    return origin.port;
  }
  if (origin.protocol === "https:") {
    return "443";
  }
  if (origin.protocol === "http:") {
    return "80";
  }
  return undefined;
}

function applyWebSocketForwardedHeaders(
  result: Record<string, string>,
  headers: Array<[string, string]>,
  runtime: PreviewRuntime,
): void {
  const host = getHeaderValue(headers, "host");
  const origin = getForwardedOriginParts(headers, runtime);
  const port = getForwardedPort(origin);
  result["x-forwarded-host"] = host || origin.host;
  result["x-forwarded-proto"] = origin.protocol.replace(":", "");
  if (port) {
    result["x-forwarded-port"] = port;
  }
}

function rewritePreviewLocationHeader(value: string, runtime: PreviewRuntime): string {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("//") && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed))) {
    return value;
  }

  let locationUrl: URL;
  try {
    locationUrl = new URL(trimmed, runtime.targetBaseUrl);
  } catch {
    return value;
  }
  if (locationUrl.origin !== runtime.targetOrigin) {
    return value;
  }
  return `${runtime.localOrigin}${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`;
}

function rewritePreviewResponseHeaders(headers: Headers, runtime: PreviewRuntime): Array<[string, string]> {
  return Array.from(headers.entries()).map(([name, value]) => [
    name,
    name.toLowerCase() === "location" ? rewritePreviewLocationHeader(value, runtime) : value,
  ]);
}

function derivePreviewLocalOrigin(localUrl: string, localHost: string, localPort: number): string {
  const trimmedLocalUrl = localUrl.trim();
  if (trimmedLocalUrl) {
    try {
      return new URL(trimmedLocalUrl).origin;
    } catch (error) {
      log.warn("Invalid preview localUrl from CLI bridge; falling back to local host and port", { error: String(error) });
    }
  }

  const fallbackUrl = new URL("http://localhost");
  fallbackUrl.hostname = localHost;
  fallbackUrl.port = String(localPort);
  return fallbackUrl.origin;
}

export class PreviewSessionManager {
  private runtimes = new Map<string, PreviewRuntime>();
  private upstreamSockets = new Map<string, Map<string, UpstreamWebSocketState>>();
  private bridgeSockets = new Map<string, PreviewBridgeSocket>();
  private initializedUserIds = new Set<string>();
  private initializingByUserId = new Map<string, Promise<void>>();

  async initialize(): Promise<void> {
    const user = requireCurrentUser();
    if (this.initializedUserIds.has(user.id)) {
      return;
    }
    const existing = this.initializingByUserId.get(user.id);
    if (existing) {
      await existing;
      return;
    }

    const initializing = this.reconcileStalePreviews();
    this.initializingByUserId.set(user.id, initializing);
    try {
      await initializing;
      this.initializedUserIds.add(user.id);
    } finally {
      this.initializingByUserId.delete(user.id);
    }
  }

  async resolveWorkspaceReference(reference: string): Promise<Workspace> {
    const normalized = reference.trim();
    if (!normalized) {
      throw new Error("Workspace is required");
    }
    const workspaceById = await getWorkspace(normalized);
    if (workspaceById) {
      return workspaceById;
    }

    const matches = (await listWorkspaces()).filter((workspace) => workspace.name === normalized);
    if (matches.length === 0) {
      throw new Error(`Workspace not found: ${normalized}`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((workspace) => `${workspace.name} (${workspace.id})`).join(", ");
      throw new Error(`Workspace name is ambiguous: ${normalized}. Matching workspaces: ${candidates}`);
    }
    return matches[0]!;
  }

  async registerCliPreview(options: RegisterCliPreviewOptions): Promise<{ preview: PreviewSession; targetBaseUrl: string; tunnel?: ChildProcess }> {
    await this.initialize();
    const workspace = await this.resolveWorkspaceReference(options.workspace);
    await touchWorkspace(workspace.id);
    const sshTunnel = workspace.serverSettings.agent.transport === "ssh"
      ? await this.startSshTunnel(workspace, options.remoteHost, options.remotePort)
      : undefined;
    const targetPort = sshTunnel ? sshTunnel.localPort : options.remotePort;
    const targetHost = sshTunnel ? LOCAL_TUNNEL_HOST : options.remoteHost;
    const now = new Date().toISOString();
    const preview: PreviewSession = {
      config: {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        remoteHost: options.remoteHost,
        remotePort: options.remotePort,
        localHost: options.localHost,
        localPort: options.localPort,
        localUrl: options.localUrl,
        initialPath: normalizeInitialPath(options.initialPath),
        cliClientId: options.cliClientId,
        cliHostname: options.cliHostname,
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "active",
        connectedAt: now,
      },
    };
    await savePreviewSession(preview);
    const targetBaseUrl = `http://${targetHost}:${String(targetPort)}`;
    this.runtimes.set(preview.config.id, {
      localOrigin: derivePreviewLocalOrigin(options.localUrl, options.localHost, options.localPort),
      user: requireCurrentUser(),
      targetBaseUrl,
      targetOrigin: new URL(targetBaseUrl).origin,
      tunnel: sshTunnel?.child,
      tunnelLocalPort: sshTunnel?.localPort,
    });
    previewEventEmitter.emit({
      type: "preview.created",
      previewId: preview.config.id,
      workspaceId: workspace.id,
      preview,
      timestamp: now,
    });
    previewEventEmitter.emit({
      type: "preview.connected",
      previewId: preview.config.id,
      workspaceId: workspace.id,
      preview,
      timestamp: now,
    });
    return { preview, targetBaseUrl, tunnel: sshTunnel?.child };
  }

  async listWorkspacePreviews(workspaceId: string): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByWorkspaceAndStatuses(workspaceId, ["active", "closing"]);
  }

  async listActivePreviews(): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByStatuses(["active", "closing"]);
  }

  async getPreview(id: string): Promise<PreviewSession | null> {
    await this.initialize();
    return await getPreviewSession(id);
  }

  async closePreview(id: string, reason = "Preview closed"): Promise<boolean> {
    await this.initialize();
    const preview = await getPreviewSession(id);
    if (!preview) {
      return false;
    }
    const runtime = this.runtimes.get(id);
    if (runtime?.tunnel) {
      runtime.tunnel.kill("SIGTERM");
      await waitForProcessExit(runtime.tunnel, STOP_TIMEOUT_MS);
      if (runtime.tunnel.exitCode === null) {
        runtime.tunnel.kill("SIGKILL");
      }
    }
    this.closeUpstreamSockets(id);
    const bridgeSocket = this.bridgeSockets.get(id);
    if (bridgeSocket) {
      this.bridgeSockets.delete(id);
      bridgeSocket.data.previewBridgeSessionId = undefined;
      bridgeSocket.close(1000, reason);
    }
    this.runtimes.delete(id);
    const now = new Date().toISOString();
    const closedPreview: PreviewSession = {
      config: { ...preview.config, updatedAt: now },
      state: {
        ...preview.state,
        status: "closed",
        closedAt: now,
        error: reason,
      },
    };
    await deletePreviewSession(id);
    previewEventEmitter.emit({
      type: "preview.closed",
      previewId: id,
      workspaceId: preview.config.workspaceId,
      preview: closedPreview,
      timestamp: now,
    });
    return true;
  }

  async markPreviewFailed(id: string, error: string): Promise<void> {
    const preview = await getPreviewSession(id);
    if (!preview) {
      previewEventEmitter.emit({
        type: "preview.failed",
        previewId: id,
        workspaceId: "",
        error,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const now = new Date().toISOString();
    const failedPreview: PreviewSession = {
      config: { ...preview.config, updatedAt: now },
      state: {
        ...preview.state,
        status: "failed",
        closedAt: now,
        error,
      },
    };
    await deletePreviewSession(id);
    previewEventEmitter.emit({
      type: "preview.failed",
      previewId: id,
      workspaceId: preview.config.workspaceId,
      error,
      preview: failedPreview,
      timestamp: now,
    });
  }

  async handleBridgeMessage(ws: PreviewBridgeSocket, rawMessage: string | Buffer): Promise<void> {
    const message = JSON.parse(typeof rawMessage === "string" ? rawMessage : rawMessage.toString()) as PreviewBridgeClientMessage;
    if (message.type === "hello") {
      await this.handleHello(ws, message);
      return;
    }
    if (message.type === "request.start") {
      await this.handleRequest(ws, message);
      return;
    }
    if (message.type === "websocket.open") {
      this.handleWebSocketOpen(ws, message);
      return;
    }
    if (message.type === "websocket.message") {
      this.handleWebSocketMessage(ws, message);
      return;
    }
    if (message.type === "websocket.close") {
      this.handleWebSocketClose(ws, message);
    }
  }

  async closeBridgeSession(ws: PreviewBridgeSocket, reason: string): Promise<void> {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId || !ws.data.user) {
      return;
    }
    this.bridgeSockets.delete(previewId);
    await runWithCurrentUser(ws.data.user, () => this.closePreview(previewId, reason));
    ws.data.previewBridgeSessionId = undefined;
  }

  private async handleHello(ws: PreviewBridgeSocket, message: PreviewBridgeHelloMessage): Promise<void> {
    const { preview } = await this.registerCliPreview(message);
    ws.data.previewBridgeSessionId = preview.config.id;
    this.bridgeSockets.set(preview.config.id, ws);
    ws.send(JSON.stringify({
      type: "ready",
      previewId: preview.config.id,
      workspaceId: preview.config.workspaceId,
    }));
  }

  private async handleRequest(
    ws: PreviewBridgeSocket,
    message: Extract<PreviewBridgeClientMessage, { type: "request.start" }>,
  ): Promise<void> {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview bridge is not ready" }));
      return;
    }
    const runtime = this.runtimes.get(previewId);
    if (!runtime) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview runtime is not available" }));
      return;
    }

    try {
      const targetUrl = new URL(message.path, runtime.targetBaseUrl);
      const headers = new Headers(message.headers);
      const response = await fetch(targetUrl, {
        method: message.method,
        headers,
        body: message.body ? Buffer.from(decodeBase64(message.body)) : undefined,
        redirect: "manual",
      });
      ws.send(JSON.stringify({
        type: "response.start",
        streamId: message.streamId,
        status: response.status,
        headers: rewritePreviewResponseHeaders(response.headers, runtime),
      }));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          ws.send(JSON.stringify({
            type: "response.body",
            streamId: message.streamId,
            body: encodeBase64(value),
          }));
        }
      }
      ws.send(JSON.stringify({ type: "response.end", streamId: message.streamId }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: String(error) }));
    }
  }

  private handleWebSocketOpen(ws: PreviewBridgeSocket, message: PreviewBridgeWebSocketOpenMessage): void {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview bridge is not ready" }));
      return;
    }
    const runtime = this.runtimes.get(previewId);
    if (!runtime) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview runtime is not available" }));
      return;
    }

    const targetUrl = new URL(message.path, runtime.targetBaseUrl);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
    const upstream = createUpstreamWebSocket(targetUrl, this.buildUpstreamWebSocketHeaders(message.headers, runtime));
    const upstreamState: UpstreamWebSocketState = { socket: upstream, queuedMessages: [] };
    const sockets = this.getUpstreamSocketMap(previewId);
    sockets.set(message.streamId, upstreamState);

    upstream.addEventListener("open", () => {
      for (const queuedMessage of upstreamState.queuedMessages.splice(0)) {
        upstream.send(queuedMessage);
      }
    });
    upstream.addEventListener("message", (event: MessageEvent) => {
      const body = typeof event.data === "string"
        ? new TextEncoder().encode(event.data)
        : event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data instanceof Blob
            ? undefined
            : event.data instanceof Uint8Array
              ? event.data
              : Buffer.from(event.data as Buffer);
      if (!body) {
        void event.data.arrayBuffer().then((buffer: ArrayBuffer) => {
          ws.send(JSON.stringify({
            type: "websocket.message",
            streamId: message.streamId,
            body: encodeBase64(new Uint8Array(buffer)),
            binary: true,
          } satisfies PreviewBridgeWebSocketMessage));
        }).catch((error: unknown) => {
          ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: String(error) }));
        });
        return;
      }
      ws.send(JSON.stringify({
        type: "websocket.message",
        streamId: message.streamId,
        body: encodeBase64(body),
        binary: typeof event.data !== "string",
      } satisfies PreviewBridgeWebSocketMessage));
    });
    upstream.addEventListener("close", (event: CloseEvent) => {
      sockets.delete(message.streamId);
      ws.send(JSON.stringify({
        type: "websocket.close",
        streamId: message.streamId,
        code: event.code,
        reason: event.reason,
      } satisfies PreviewBridgeWebSocketCloseMessage));
    });
    upstream.addEventListener("error", () => {
      sockets.delete(message.streamId);
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview upstream WebSocket failed" }));
    });
  }

  private handleWebSocketMessage(ws: PreviewBridgeSocket, message: PreviewBridgeWebSocketMessage): void {
    const upstream = this.getUpstreamSocket(ws, message.streamId);
    if (!upstream) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview upstream WebSocket is not available" }));
      return;
    }
    const body = decodeBase64(message.body);
    const payload = message.binary
      ? toArrayBuffer(body)
      : new TextDecoder().decode(body);
    if (upstream.socket.readyState === WebSocket.OPEN) {
      upstream.socket.send(payload);
      return;
    }
    upstream.queuedMessages.push(payload);
  }

  private handleWebSocketClose(ws: PreviewBridgeSocket, message: PreviewBridgeWebSocketCloseMessage): void {
    const previewId = ws.data.previewBridgeSessionId;
    const upstream = this.getUpstreamSocket(ws, message.streamId);
    if (!upstream) {
      return;
    }
    if (previewId) {
      this.upstreamSockets.get(previewId)?.delete(message.streamId);
    }
    if (upstream.socket.readyState < WS_READY_STATE_CLOSING) {
      upstream.socket.close(message.code, message.reason);
    }
  }

  private getUpstreamSocket(ws: PreviewBridgeSocket, streamId: string): UpstreamWebSocketState | undefined {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId) {
      return undefined;
    }
    return this.upstreamSockets.get(previewId)?.get(streamId);
  }

  private getUpstreamSocketMap(previewId: string): Map<string, UpstreamWebSocketState> {
    let sockets = this.upstreamSockets.get(previewId);
    if (!sockets) {
      sockets = new Map();
      this.upstreamSockets.set(previewId, sockets);
    }
    return sockets;
  }

  private closeUpstreamSockets(previewId: string): void {
    const sockets = this.upstreamSockets.get(previewId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets.values()) {
      if (socket.socket.readyState < WS_READY_STATE_CLOSING) {
        socket.socket.close(1000, "Preview bridge closed");
      }
    }
    this.upstreamSockets.delete(previewId);
  }

  private buildUpstreamWebSocketHeaders(headers: Array<[string, string]>, runtime: PreviewRuntime): Record<string, string> {
    const result: Record<string, string> = {};
    const excluded = new Set([
      "connection",
      "sec-websocket-accept",
      "sec-websocket-extensions",
      "sec-websocket-key",
      "sec-websocket-version",
      "upgrade",
    ]);
    for (const [name, value] of headers) {
      const lowerName = name.toLowerCase();
      if (excluded.has(lowerName)) {
        continue;
      }
      result[name] = value;
    }
    applyWebSocketForwardedHeaders(result, headers, runtime);
    return result;
  }

  private async reconcileStalePreviews(): Promise<void> {
    const previews = await listPreviewSessionsByStatuses(["active", "closing"]);
    for (const preview of previews) {
      const now = new Date().toISOString();
      const closedPreview: PreviewSession = {
        config: { ...preview.config, updatedAt: now },
        state: {
          ...preview.state,
          status: "closed",
          closedAt: now,
          error: "Preview was closed because the server restarted or the bridge connection was lost",
        },
      };
      await deletePreviewSession(preview.config.id);
      previewEventEmitter.emit({
        type: "preview.closed",
        previewId: preview.config.id,
        workspaceId: preview.config.workspaceId,
        preview: closedPreview,
        timestamp: now,
      });
    }
  }

  private async startSshTunnel(
    workspace: Workspace,
    remoteHost: string,
    remotePort: number,
  ): Promise<{ child: ChildProcess; localPort: number }> {
    const localPort = await ensureLocalPortAvailable(this.getReservedTunnelPorts());
    const target = getSshConnectionTargetFromWorkspace(workspace);
    const config = buildSshProcessConfig({
      target,
      connectionScope: workspace.directory,
      extraArgs: [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${LOCAL_TUNNEL_HOST}:${String(localPort)}:${remoteHost}:${String(remotePort)}`,
      ],
      passwordHandling: "environment",
    });
    log.debug("Starting preview SSH tunnel", { workspaceId: workspace.id, localPort, remoteHost, remotePort });
    const child = spawn(config.command, config.args, {
      env: config.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitForProcessStartup(child, STARTUP_GRACE_MS);
    return { child, localPort };
  }

  private getReservedTunnelPorts(): Set<number> {
    const reserved = new Set<number>();
    for (const runtime of this.runtimes.values()) {
      if (runtime.tunnelLocalPort) {
        reserved.add(runtime.tunnelLocalPort);
      }
    }
    return reserved;
  }
}

export const previewSessionManager = new PreviewSessionManager();
