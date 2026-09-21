/**
 * Core manager for CLI-owned workspace and direct server preview sessions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  type ExecutionHostBinding,
  type ExecutionHostRef,
  type PreviewBridgeClientMessage,
  type PreviewBridgeHelloMessage,
  type PreviewBridgeWebSocketCloseMessage,
  type PreviewBridgeWebSocketMessage,
  type PreviewBridgeWebSocketOpenMessage,
  type PreviewSession,
  type PreviewTarget,
  type RegisterCliPreviewOptions,
  type Workspace,
  parsePreviewBridgePath,
} from "@/shared";
import { getWorkspace, listWorkspaces, touchWorkspace } from "../persistence/workspaces";
import {
  deletePreviewSession,
  getPreviewSession,
  listPreviewSessionsByExecutionHostAndStatuses,
  listPreviewSessionsByWorkspaceAndStatuses,
  listPreviewSessionsByStatuses,
  savePreviewSession,
} from "../persistence/preview-sessions";
import { createLogger } from "@pablozaiden/webapp/server";
import { DomainError } from "../domain/domain-error";
import { previewEventEmitter } from "./event-emitter";
import { ensureLocalPortAvailable } from "./local-port-allocator";
import { buildSshProcessConfig } from "./ssh-connection-target";
import { openPreviewTcpForward, type PreviewTcpForward } from "./preview-tcp-forward";
import {
  resolveWorkspaceExecutionTarget,
  type ResolvedWorkspaceExecutionTarget,
} from "./workspace-execution-target";
import { executionHostService } from "./execution-host-service";
import { waitForProcessExit, waitForProcessStartup } from "./process-lifecycle";
import { requireCurrentUser, runWithCurrentUser } from "../context/user-context";

const log = createLogger("core:preview-session-manager");
const LOCAL_TUNNEL_HOST = "127.0.0.1";
const STARTUP_GRACE_MS = 500;
const STOP_TIMEOUT_MS = 2000;
const WS_READY_STATE_CLOSING = 2;
const PREVIEW_DESTINATION_REJECTED_MESSAGE = "Preview destination rejected";
const UPSTREAM_EXCLUDED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-version",
]);
const UPSTREAM_CONTROLLED_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

interface PreviewRuntime {
  localOrigin: string;
  user: CurrentUser;
  targetBaseUrl: string;
  targetOrigin: string;
  tunnel?: ChildProcess;
  meshForward?: PreviewTcpForward;
  tunnelLocalPort?: number;
}

interface PreviewBridgeSocket {
  data: {
    previewBridgeSessionId?: string;
    previewBridgeUserId?: string;
    user?: CurrentUser;
  };
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface UpstreamWebSocketState {
  socket: WebSocket;
  queuedMessages: Array<string | ArrayBuffer>;
}

export interface PreviewSessionManagerDependencies {
  openPreviewTcpForward?: typeof openPreviewTcpForward;
}

type ResolvedPreviewTarget =
  | {
      kind: "workspace";
      workspace: Workspace;
      executionTarget: ResolvedWorkspaceExecutionTarget;
      binding: ExecutionHostBinding;
    }
  | {
      kind: "server";
      binding: ExecutionHostBinding;
      transportKind: "local" | "mesh";
    };

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
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed;
      }
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

function applyUpstreamForwardedHeaders(
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

function buildUpstreamHeaders(
  headers: Array<[string, string]>,
  runtime: PreviewRuntime,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (UPSTREAM_EXCLUDED_HEADERS.has(lowerName) || UPSTREAM_CONTROLLED_HEADERS.has(lowerName)) {
      continue;
    }
    result[name] = value;
  }
  applyUpstreamForwardedHeaders(result, headers, runtime);
  return result;
}

function resolvePreviewDestination(runtime: PreviewRuntime, path: unknown): URL {
  const previewPath = parsePreviewBridgePath(path);
  if (!previewPath) {
    throw new DomainError(
      "preview_destination_rejected",
      PREVIEW_DESTINATION_REJECTED_MESSAGE,
    );
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(previewPath, runtime.targetBaseUrl);
  } catch (error) {
    throw new DomainError(
      "preview_destination_rejected",
      PREVIEW_DESTINATION_REJECTED_MESSAGE,
      { cause: error },
    );
  }
  if (targetUrl.origin !== runtime.targetOrigin) {
    throw new DomainError(
      "preview_destination_rejected",
      PREVIEW_DESTINATION_REJECTED_MESSAGE,
    );
  }
  return targetUrl;
}

function getBridgeErrorMessage(error: unknown): string {
  if (error instanceof DomainError && error.code === "preview_destination_rejected") {
    return PREVIEW_DESTINATION_REJECTED_MESSAGE;
  }
  return String(error);
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

  constructor(
    private readonly dependencies: PreviewSessionManagerDependencies = {},
  ) {}

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
      throw new DomainError("workspace_reference_required", "Workspace is required");
    }
    const workspaceById = await getWorkspace(normalized);
    if (workspaceById) {
      return workspaceById;
    }

    const matches = (await listWorkspaces()).filter((workspace) => workspace.name === normalized);
    if (matches.length === 0) {
      throw new DomainError("workspace_not_found", "Workspace not found", {
        details: { reference: normalized },
      });
    }
    if (matches.length > 1) {
      throw new DomainError(
        "workspace_name_ambiguous",
        "Workspace name is ambiguous",
        {
          details: {
            reference: normalized,
            candidates: matches.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
            })),
          },
        },
      );
    }
    return matches[0]!;
  }

  private async resolvePreviewTarget(target: PreviewTarget): Promise<ResolvedPreviewTarget> {
    if (target.kind === "workspace") {
      const workspace = await this.resolveWorkspaceReference(target.reference);
      await touchWorkspace(workspace.id);
      const executionTarget = await resolveWorkspaceExecutionTarget(workspace);
      return {
        kind: "workspace",
        workspace,
        executionTarget,
        binding: executionTarget.binding,
      };
    }

    const descriptor = await executionHostService.resolveReference(target.reference);
    if (descriptor.ref.kind === "ssh") {
      throw new DomainError(
        "preview_server_unsupported",
        "Direct previews are not supported for SSH servers. Use a workspace preview instead.",
      );
    }
    const binding = executionHostService.getBinding(descriptor.ref);
    executionHostService.requireBindingCapability(binding, "tcpTunnel");
    return {
      kind: "server",
      binding,
      transportKind: descriptor.ref.kind,
    };
  }

  async registerCliPreview(options: RegisterCliPreviewOptions): Promise<{ preview: PreviewSession; targetBaseUrl: string; tunnel?: ChildProcess }> {
    await this.initialize();
    const target = await this.resolvePreviewTarget(options.target);
    const workspace = target.kind === "workspace" ? target.workspace : undefined;
    let sshTunnel: { child: ChildProcess; localPort: number } | undefined;
    let meshForward: PreviewTcpForward | undefined;
    let preview: PreviewSession | undefined;
    let previewSaved = false;
    let runtimeRegistered = false;

    try {
      sshTunnel = target.kind === "workspace" && target.executionTarget.kind === "ssh"
        ? await this.startSshTunnel(target.workspace, target.executionTarget, options.remoteHost, options.remotePort)
        : undefined;
      const transportKind = target.kind === "workspace"
        ? target.executionTarget.kind
        : target.transportKind;
      meshForward = transportKind === "mesh"
        ? await (this.dependencies.openPreviewTcpForward ?? openPreviewTcpForward)(
          target.binding,
          options.remotePort,
        )
        : undefined;
      const targetPort = sshTunnel?.localPort ?? meshForward?.localPort ?? options.remotePort;
      const targetHost = sshTunnel || meshForward ? LOCAL_TUNNEL_HOST : options.remoteHost;
      const now = new Date().toISOString();
      preview = {
        config: {
          id: crypto.randomUUID(),
          targetKind: target.kind,
          workspaceId: workspace?.id,
          executionHostBinding: target.binding,
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
      previewSaved = true;
      const targetBaseUrl = `http://${targetHost}:${String(targetPort)}`;
      this.runtimes.set(preview.config.id, {
        localOrigin: derivePreviewLocalOrigin(options.localUrl, options.localHost, options.localPort),
        user: requireCurrentUser(),
        targetBaseUrl,
        targetOrigin: new URL(targetBaseUrl).origin,
        tunnel: sshTunnel?.child,
        meshForward,
        tunnelLocalPort: sshTunnel?.localPort ?? meshForward?.localPort,
      });
      runtimeRegistered = true;
      previewEventEmitter.emit({
        type: "preview.created",
        previewId: preview.config.id,
        workspaceId: workspace?.id,
        executionHostBinding: target.binding,
        preview,
        timestamp: now,
      });
      previewEventEmitter.emit({
        type: "preview.connected",
        previewId: preview.config.id,
        workspaceId: workspace?.id,
        executionHostBinding: target.binding,
        preview,
        timestamp: now,
      });
      return { preview, targetBaseUrl, tunnel: sshTunnel?.child };
    } catch (error) {
      if (preview && runtimeRegistered) {
        this.runtimes.delete(preview.config.id);
        this.closeUpstreamSockets(preview.config.id);
      }
      if (preview && previewSaved) {
        try {
          await deletePreviewSession(preview.config.id);
        } catch (cleanupError) {
          log.error("Unable to remove failed preview session", {
            previewId: preview.config.id,
            error: String(cleanupError),
          });
        }
      }
      try {
        await this.closePreviewTransports(sshTunnel?.child, meshForward);
      } catch (cleanupError) {
        log.error("Unable to clean up failed preview transport", {
          workspaceId: workspace?.id,
          error: String(cleanupError),
        });
      }
      throw error;
    }
  }

  async listWorkspacePreviews(workspaceId: string): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByWorkspaceAndStatuses(workspaceId, ["active", "closing"]);
  }

  async listServerPreviews(executionHostRef: ExecutionHostRef): Promise<PreviewSession[]> {
    await this.initialize();
    if (executionHostRef.kind === "ssh") {
      throw new DomainError(
        "preview_server_unsupported",
        "Direct previews are not supported for SSH servers.",
      );
    }
    const binding = executionHostService.getBinding(executionHostRef);
    executionHostService.requireBindingCapability(binding, "tcpTunnel");
    return await listPreviewSessionsByExecutionHostAndStatuses(
      binding,
      ["active", "closing"],
    );
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
    await this.closePreviewTransports(runtime?.tunnel, runtime?.meshForward);
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
      executionHostBinding: preview.config.executionHostBinding,
      preview: closedPreview,
      timestamp: now,
    });
    return true;
  }

  private async closePreviewTransports(
    tunnel: ChildProcess | undefined,
    meshForward: PreviewTcpForward | undefined,
  ): Promise<void> {
    try {
      if (tunnel) {
        tunnel.kill("SIGTERM");
        await waitForProcessExit(tunnel, STOP_TIMEOUT_MS);
        if (tunnel.exitCode === null) {
          tunnel.kill("SIGKILL");
        }
      }
    } finally {
      if (meshForward) {
        await meshForward.close();
      }
    }
  }

  async markPreviewFailed(id: string, error: string): Promise<void> {
    const preview = await getPreviewSession(id);
    if (!preview) {
      previewEventEmitter.emit({
        type: "preview.failed",
        previewId: id,
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
      executionHostBinding: preview.config.executionHostBinding,
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
    if (
      ws.data.previewBridgeUserId
      && ws.data.previewBridgeUserId !== ws.data.user.id
    ) {
      ws.data.previewBridgeSessionId = undefined;
      return;
    }
    if (this.bridgeSockets.get(previewId) !== ws) {
      ws.data.previewBridgeSessionId = undefined;
      return;
    }
    this.bridgeSockets.delete(previewId);
    await runWithCurrentUser(ws.data.user, () => this.closePreview(previewId, reason));
    ws.data.previewBridgeSessionId = undefined;
  }

  private async handleHello(ws: PreviewBridgeSocket, message: PreviewBridgeHelloMessage): Promise<void> {
    const user = ws.data.user;
    const currentUser = requireCurrentUser();
    if (
      !user
      || currentUser.id !== user.id
      || (
        ws.data.previewBridgeUserId
        && ws.data.previewBridgeUserId !== user.id
      )
    ) {
      throw new DomainError(
        "preview_bridge_unauthorized",
        "Authenticated user context is required for preview bridges",
      );
    }
    if (ws.data.previewBridgeSessionId) {
      ws.send(JSON.stringify({
        type: "stream.error",
        error: "Preview bridge is already ready",
      }));
      return;
    }
    const { preview } = await this.registerCliPreview(message);
    ws.data.previewBridgeSessionId = preview.config.id;
    this.bridgeSockets.set(preview.config.id, ws);
    ws.send(JSON.stringify({
      type: "ready",
      previewId: preview.config.id,
      targetKind: preview.config.targetKind,
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
    const runtime = this.getOwnedRuntime(ws, previewId);
    if (!runtime) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview runtime is not available" }));
      return;
    }

    try {
      const targetUrl = resolvePreviewDestination(runtime, message.path);
      const headers = buildUpstreamHeaders(message.headers, runtime);
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
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: getBridgeErrorMessage(error) }));
    }
  }

  private handleWebSocketOpen(ws: PreviewBridgeSocket, message: PreviewBridgeWebSocketOpenMessage): void {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview bridge is not ready" }));
      return;
    }
    const runtime = this.getOwnedRuntime(ws, previewId);
    if (!runtime) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview runtime is not available" }));
      return;
    }

    try {
      const targetUrl = resolvePreviewDestination(runtime, message.path);
      targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
      const upstream = createUpstreamWebSocket(targetUrl, buildUpstreamHeaders(message.headers, runtime));
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
    } catch (error) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: getBridgeErrorMessage(error) }));
    }
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
    if (!previewId || !this.getOwnedRuntime(ws, previewId)) {
      return undefined;
    }
    return this.upstreamSockets.get(previewId)?.get(streamId);
  }

  private getOwnedRuntime(
    ws: PreviewBridgeSocket,
    previewId: string,
  ): PreviewRuntime | undefined {
    const runtime = this.runtimes.get(previewId);
    const user = ws.data.user;
    if (
      !runtime
      || !user
      || runtime.user.id !== user.id
      || (
        ws.data.previewBridgeUserId
        && ws.data.previewBridgeUserId !== user.id
      )
      || this.bridgeSockets.get(previewId) !== ws
    ) {
      return undefined;
    }
    return runtime;
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
        executionHostBinding: preview.config.executionHostBinding,
        preview: closedPreview,
        timestamp: now,
      });
    }
  }

  private async startSshTunnel(
    workspace: Workspace,
    executionTarget: Extract<ResolvedWorkspaceExecutionTarget, { kind: "ssh" }>,
    remoteHost: string,
    remotePort: number,
  ): Promise<{ child: ChildProcess; localPort: number }> {
    const localPort = await ensureLocalPortAvailable(this.getReservedTunnelPorts());
    const config = buildSshProcessConfig({
      target: executionTarget.target,
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
    log.debug("Starting preview SSH tunnel", {
      workspaceId: workspace.id,
      localPort,
      remoteHost,
      remotePort,
    });
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
