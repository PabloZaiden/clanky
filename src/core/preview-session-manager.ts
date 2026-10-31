/**
 * Core manager for CLI-owned workspace and direct server preview sessions.
 */

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
  previewWebSocketCloseCode,
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
import { openPreviewTcpForward, openPreviewTlsForward, type PreviewTcpForward } from "./preview-tcp-forward";
import {
  resolveWorkspaceExecutionTarget,
  type ResolvedWorkspaceExecutionTarget,
} from "./workspace-execution-target";
import { executionHostService } from "./execution-host-service";
import { PREVIEW_RESPONSE_CHUNK_BYTES, PREVIEW_RESPONSE_WINDOW_BYTES } from "@/shared/preview";
import { requireCurrentUser, requireExecutionOwnerUser, runWithExecutionOwner } from "../context/user-context";
import { CodePreviewHelloSchema, PreviewUpstreamOptionsSchema } from "../contracts/schemas/preview";
import { resolveCodePreviewTarget } from "./code-preview-target";
import { startCodeServer, waitForCodeEditor, type CodeServer } from "./code-server";
import { cleanupCodeSession } from "./code-session-resources";
import { closeCommandExecutor } from "./command-executor";
import { withWorkspaceExecutionLock } from "./workspace-execution-lock";
import { getInteractiveResourceInternal } from "./collaboration-interactive";

const log = createLogger("core:preview-session-manager");
const LOCAL_TUNNEL_HOST = "127.0.0.1";
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
  codeServer?: CodeServer;
  requests: Map<string, {
    controller: AbortController;
    creditBytes?: number;
    lastAcknowledgedAt: number;
  }>;
  localOrigin: string;
  user: CurrentUser;
  targetBaseUrl: string;
  targetOrigin: string;
  applicationOrigin: string;
  upstreamTls?: Bun.TLSOptions;
  meshForward?: PreviewTcpForward;
  webSocketForward?: PreviewTcpForward;
}

interface PreviewBridgeSocket {
  data: {
    previewBridgeSessionId?: string;
    previewBridgeUserId?: string;
    user?: CurrentUser;
  };
  send(data: string | Uint8Array): void;
  getBufferedAmount?(): number;
  close(code?: number, reason?: string): void;
}

interface UpstreamWebSocketState {
  socket: WebSocket;
  queuedMessages: Array<string | ArrayBuffer>;
  queuedBytes: number;
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
  if (runtime.codeServer) {
    const cookies = (getHeaderValue(headers, "cookie") ?? "")
      .split(";").map((cookie) => cookie.trim())
      .filter((cookie) => cookie && !cookie.startsWith("vscode-tkn="));
    for (const name of Object.keys(result)) {
      if (name.toLowerCase() === "cookie") delete result[name];
    }
    // VS Code's native cookie authenticates HTTP and seeds its browser RPC handshake.
    result["cookie"] = [...cookies, `vscode-tkn=${runtime.codeServer.token}`].join("; ");
  }
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
  if (locationUrl.origin !== runtime.targetOrigin && locationUrl.origin !== runtime.applicationOrigin) {
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
  private starting = new Map<PreviewBridgeSocket, { controller: AbortController; promise: Promise<void> }>();
  private closing = new Map<string, Promise<boolean>>();
  private registering = new Map<string, {
    userId: string;
    controller: AbortController;
    completion: Promise<void>;
  }>();

  constructor(
    private readonly dependencies: PreviewSessionManagerDependencies = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initializedUserIds.has(requireExecutionOwnerUser().id)) return;
    await this.reconcilePreviewResources();
  }

  async retryPendingCleanup(): Promise<void> {
    await this.initialize();
    await this.reconcilePreviewResources();
  }

  private async reconcilePreviewResources(): Promise<void> {
    const user = requireExecutionOwnerUser();
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
        `Workspace name is ambiguous; use an ID: ${matches.map((workspace) => workspace.id).join(", ")}`,
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
      const executionTarget = await resolveWorkspaceExecutionTarget(workspace);
      return {
        kind: "workspace",
        workspace,
        executionTarget,
        binding: executionTarget.binding,
      };
    }

    const descriptor = await executionHostService.resolveReference(target.reference);
    const binding = executionHostService.getBinding(descriptor.ref);
    executionHostService.requireBindingCapability(binding, "tcpTunnel");
    return {
      kind: "server",
      binding,
      transportKind: descriptor.ref.kind,
    };
  }

  async registerCliPreview(options: RegisterCliPreviewOptions, signal?: AbortSignal): Promise<{ preview: PreviewSession; targetBaseUrl: string; codeServer?: CodeServer }> {
    const upstream = PreviewUpstreamOptionsSchema.safeParse(options);
    if (!upstream.success) {
      throw new DomainError("preview_target_invalid", "Invalid preview HTTPS options.");
    }
    options = { ...options, ...upstream.data };
    await this.initialize();
    signal?.throwIfAborted();
    const target = await this.resolvePreviewTarget(options.target);
    const register = async () => {
      signal?.throwIfAborted();
      const currentTarget = target.kind === "workspace"
        ? await this.resolvePreviewTarget({ kind: "workspace", reference: target.workspace.id })
        : target;
      const registerOnHost = async () => {
        signal?.throwIfAborted();
        executionHostService.validateBinding(currentTarget.binding);
        const id = crypto.randomUUID();
        const controller = new AbortController();
        const completion = Promise.withResolvers<void>();
        this.registering.set(id, { userId: requireExecutionOwnerUser().id, controller, completion: completion.promise });
        try {
          return await this.registerResolvedPreview({
            id, options, target: currentTarget,
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          });
        } finally {
          this.registering.delete(id);
          completion.resolve();
        }
      };
      return await registerOnHost();
    };
    return target.kind === "workspace"
      ? await withWorkspaceExecutionLock(target.workspace.id, register)
      : await register();
  }

  private async registerResolvedPreview(context: {
    id: string;
    options: RegisterCliPreviewOptions;
    target: ResolvedPreviewTarget;
    signal: AbortSignal;
  }): Promise<{ preview: PreviewSession; targetBaseUrl: string; codeServer?: CodeServer }> {
    const { id, options, target, signal } = context;
    const workspace = target.kind === "workspace" ? target.workspace : undefined;
    let meshForward: PreviewTcpForward | undefined;
    let webSocketForward: PreviewTcpForward | undefined;
    const createdAt = new Date().toISOString();
    let preview: PreviewSession = {
      config: {
        id,
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
        createdAt,
        updatedAt: createdAt,
      },
      state: { status: "closing" },
    };
    let previewSaved = false;
    let runtimeRegistered = false;
    let codeServer: CodeServer | undefined;

    try {
      if (options.code) {
        if (target.kind !== "workspace") {
          throw new DomainError("code_target_invalid", "VS Code requires a workspace.");
        }
        const resolved = await resolveCodePreviewTarget(target.workspace, options.code);
        codeServer = await startCodeServer({
          ...resolved,
          id: preview.config.id,
          persistOwnership: async (ownership) => {
            preview.config.codeCleanup = ownership;
            await savePreviewSession(preview);
            previewSaved = true;
          },
          signal: signal ?? new AbortController().signal,
        });
      }
      signal?.throwIfAborted();
      const remotePort = codeServer?.port ?? options.remotePort;
      const transportKind = target.kind === "workspace"
        ? target.executionTarget.kind
        : target.transportKind;
      meshForward = transportKind === "mesh"
        ? await (this.dependencies.openPreviewTcpForward ?? openPreviewTcpForward)(
          target.binding,
          remotePort,
        )
        : undefined;
      const targetPort = meshForward?.localPort ?? remotePort;
      const targetHost = meshForward ? LOCAL_TUNNEL_HOST : options.remoteHost;
      const protocol = options.protocol ?? "http";
      const targetUrl = new URL(`${protocol}://localhost`);
      targetUrl.hostname = targetHost.includes(":") && !targetHost.startsWith("[") ? `[${targetHost}]` : targetHost;
      targetUrl.port = String(targetPort);
      const targetBaseUrl = targetUrl.origin;
      const applicationUrl = new URL(targetBaseUrl);
      applicationUrl.hostname = options.remoteHost.includes(":") && !options.remoteHost.startsWith("[")
        ? `[${options.remoteHost}]` : options.remoteHost;
      applicationUrl.port = String(remotePort);
      webSocketForward = protocol === "https" ? await openPreviewTlsForward({
        host: targetHost.replace(/^\[|\]$/g, ""),
        port: targetPort,
        serverName: options.remoteHost.replace(/^\[|\]$/g, ""),
      }) : undefined;
      if (codeServer) {
        await Promise.race([
          waitForCodeEditor(codeServer, targetBaseUrl, signal ?? new AbortController().signal),
          codeServer.exited.then(() => {
            throw new DomainError("code_start_failed", "VS Code stopped while preparing the editor.");
          }),
        ]);
      }
      signal?.throwIfAborted();
      if (workspace) await touchWorkspace(workspace.id);
      const now = new Date().toISOString();
      preview = {
        config: {
          ...preview.config,
          remotePort,
          updatedAt: now,
        },
        state: {
          status: "active",
          connectedAt: now,
        },
      };
      await savePreviewSession(preview);
      previewSaved = true;
      this.runtimes.set(preview.config.id, {
        codeServer,
        requests: new Map(),
        localOrigin: derivePreviewLocalOrigin(options.localUrl, options.localHost, options.localPort),
        user: requireExecutionOwnerUser(),
        targetBaseUrl,
        targetOrigin: new URL(targetBaseUrl).origin,
        applicationOrigin: applicationUrl.origin,
        upstreamTls: protocol === "https" ? {
          rejectUnauthorized: false,
          serverName: options.remoteHost.replace(/^\[|\]$/g, ""),
        } : undefined,
        meshForward,
        webSocketForward,
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
      return { preview, targetBaseUrl, codeServer };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (runtimeRegistered) {
        this.runtimes.delete(preview.config.id);
        this.closeUpstreamSockets(preview.config.id);
      }
      try {
        if (codeServer) await codeServer.close();
        else if (previewSaved) await this.cleanupSavedCodeSession(preview);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await this.closePreviewTransports(meshForward, webSocketForward);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (previewSaved) {
        try {
          if (cleanupErrors.length) await this.retainPendingCleanup(preview, cleanupErrors[0]);
          else await deletePreviewSession(preview.config.id);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        throw new DomainError("code_cleanup_failed", "Failed preview startup could not clean up all owned resources.", {
          cause: new AggregateError([error, ...cleanupErrors]),
        });
      }
      throw error;
    }
  }

  async listWorkspacePreviews(workspaceId: string): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByWorkspaceAndStatuses(workspaceId, ["active", "closing"]);
  }

  async closeWorkspacePreviews(workspaceId: string): Promise<void> {
    await this.initialize();
    const previews = await listPreviewSessionsByWorkspaceAndStatuses(workspaceId, ["active", "closing", "failed"]);
    await this.closePreviews(previews, "Workspace deleted", "Close this workspace's pending previews before deleting it.");
  }

  private async closePreviews(previews: PreviewSession[], reason: string, failureMessage: string): Promise<void> {
    const results = await Promise.allSettled(previews.map((preview) =>
      this.closePreview(preview.config.id, reason),
    ));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new DomainError("code_cleanup_failed", failureMessage, {
      cause: new AggregateError(failures),
    });
  }

  async listServerPreviews(executionHostRef: ExecutionHostRef): Promise<PreviewSession[]> {
    await this.initialize();
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

  async closePreview(id: string, reason = "Preview closed", closeCode = 1000): Promise<boolean> {
    await this.initialize();
    const registering = this.registering.get(id);
    if (registering) {
      if (registering.userId !== requireExecutionOwnerUser().id) return false;
      registering.controller.abort();
      await registering.completion;
    }
    const runtime = this.runtimes.get(id);
    if (runtime && runtime.user.id !== requireExecutionOwnerUser().id) return false;
    if (!await getPreviewSession(id)) return registering !== undefined;
    for (const request of runtime?.requests.values() ?? []) request.controller.abort();
    return await this.closePreviewOnce(id, reason, closeCode) || registering !== undefined;
  }

  private async closePreviewOnce(id: string, reason: string, closeCode: number): Promise<boolean> {
    const pending = this.closing.get(id);
    if (pending) return await pending;
    const closing = this.closePreviewOwned(id, reason, closeCode);
    this.closing.set(id, closing);
    try {
      return await closing;
    } finally {
      this.closing.delete(id);
    }
  }

  private async closePreviewOwned(id: string, reason: string, closeCode: number): Promise<boolean> {
    const preview = await getPreviewSession(id);
    if (!preview) {
      return false;
    }
    const workspaceId = preview.config.workspaceId;
    const membershipId = workspaceId
      ? getInteractiveResourceInternal({ kind: "preview", id, workspaceId })?.membershipId ?? null
      : undefined;
    const runtime = this.runtimes.get(id);
    await savePreviewSession({ ...preview, state: { ...preview.state, status: "closing" } });
    const cleanup = await Promise.allSettled([
      runtime?.codeServer ? runtime.codeServer.close() : this.cleanupSavedCodeSession(preview),
      this.closePreviewTransports(runtime?.meshForward, runtime?.webSocketForward),
    ]);
    this.closeUpstreamSockets(id);
    const bridgeSocket = this.bridgeSockets.get(id);
    if (bridgeSocket) {
      this.bridgeSockets.delete(id);
      bridgeSocket.data.previewBridgeSessionId = undefined;
    }
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) {
      await this.retainPendingCleanup(preview, failures[0]);
      bridgeSocket?.close(1011, "Preview cleanup failed");
      throw new DomainError("code_cleanup_failed", "Preview process or transport cleanup failed; cleanup remains pending.", {
        cause: new AggregateError(failures),
      });
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
      workspaceId,
      membershipId,
      executionHostBinding: preview.config.executionHostBinding,
      preview: closedPreview,
      timestamp: now,
    });
    bridgeSocket?.close(closeCode, reason);
    return true;
  }

  async closeAll(): Promise<void> {
    const starting = [...this.starting.values()];
    for (const entry of starting) entry.controller.abort();
    const cancelled = await Promise.allSettled(starting.map((entry) => entry.promise));
    const failures = cancelled.flatMap((result) =>
      result.status === "rejected" && result.reason instanceof DomainError && result.reason.code === "code_cleanup_failed"
        ? [result.reason] : [],
    );
    const closed = await Promise.allSettled([...this.runtimes.entries()].map(async ([id, runtime]) => {
      await runWithExecutionOwner(runtime.user, () => this.closePreview(id, "Clanky server stopped"));
    }));
    failures.push(...closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
    if (failures.length) {
      throw new AggregateError(failures, "Preview shutdown could not clean up all owned resources.");
    }
  }

  private async closePreviewTransports(
    meshForward: PreviewTcpForward | undefined,
    webSocketForward?: PreviewTcpForward,
  ): Promise<void> {
    const cleanup = await Promise.allSettled([
      meshForward?.close(),
      webSocketForward?.close(),
    ]);
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Preview transport cleanup failed");
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
    const workspaceId = preview.config.workspaceId;
    const membershipId = workspaceId
      ? getInteractiveResourceInternal({ kind: "preview", id, workspaceId })?.membershipId ?? null
      : undefined;
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
    await this.closePreview(id, "Preview failed", 1011);
    previewEventEmitter.emit({
      type: "preview.failed",
      previewId: id,
      workspaceId,
      membershipId,
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
    if (message.type === "close") {
      await this.closeBridgeSession(ws, "Closed from CLI");
      ws.close(1000, "Closed from CLI");
      return;
    }
    if (message.type === "request.cancel") {
      const previewId = ws.data.previewBridgeSessionId;
      if (previewId) this.getOwnedRuntime(ws, previewId)?.requests.get(message.streamId)?.controller.abort();
      return;
    }
    if (message.type === "response.ack") {
      const previewId = ws.data.previewBridgeSessionId;
      const request = previewId ? this.getOwnedRuntime(ws, previewId)?.requests.get(message.streamId) : undefined;
      if (request?.creditBytes !== undefined) {
        if (!Number.isSafeInteger(message.bytes) || message.bytes <= 0 || message.bytes > PREVIEW_RESPONSE_WINDOW_BYTES - request.creditBytes) {
          request.controller.abort();
          ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Invalid preview response acknowledgement" }));
        } else {
          request.creditBytes += message.bytes;
          request.lastAcknowledgedAt = Date.now();
        }
      }
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
    const starting = this.starting.get(ws);
    if (starting) {
      starting.controller.abort();
      const [result] = await Promise.allSettled([starting.promise]);
      if (result?.status === "rejected" && result.reason instanceof DomainError && result.reason.code === "code_cleanup_failed") {
        throw result.reason;
      }
    }
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
    const owner = this.runtimes.get(previewId)?.user;
    if (owner) await runWithExecutionOwner(owner, () => this.closePreview(previewId, reason));
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
    if (ws.data.previewBridgeSessionId || this.starting.has(ws)) {
      ws.send(JSON.stringify({
        type: "stream.error",
        error: "Preview bridge is already ready",
      }));
      return;
    }
    if (message.code !== undefined) {
      const parsed = CodePreviewHelloSchema.safeParse(message);
      if (!parsed.success) {
        throw new DomainError("code_target_invalid", "Invalid VS Code preview request.");
      }
      message = parsed.data;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(
      new DomainError("code_start_failed", "VS Code preview startup timed out."),
    ), message.code ? 120_000 : 30_000);
    const promise = this.startBridgePreview(ws, message, controller);
    this.starting.set(ws, { controller, promise });
    try {
      await promise;
    } catch (error) {
      if (error instanceof DomainError && error.code === "code_cleanup_failed") throw error;
      if (
        controller.signal.aborted
        && controller.signal.reason instanceof DOMException
        && controller.signal.reason.name === "AbortError"
        && !(error instanceof DomainError && error.code === "code_cleanup_failed")
      ) return;
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      this.starting.delete(ws);
    }
  }

  private async startBridgePreview(
    ws: PreviewBridgeSocket,
    message: PreviewBridgeHelloMessage,
    controller: AbortController,
  ): Promise<void> {
    try {
      const user = requireExecutionOwnerUser();
      const { preview, codeServer } = await this.registerCliPreview(message, controller.signal);
      ws.data.previewBridgeSessionId = preview.config.id;
      this.bridgeSockets.set(preview.config.id, ws);
      if (controller.signal.aborted) {
        await this.closePreview(preview.config.id, "Preview startup cancelled");
        controller.signal.throwIfAborted();
      }
      if (codeServer) {
        // The bridge owns the long-lived process; its exit terminates the preview.
        void codeServer.exited.then(async () => {
          if (!this.runtimes.has(preview.config.id) || this.closing.has(preview.config.id)) return;
          await runWithExecutionOwner(user, () =>
            this.closePreview(preview.config.id, "VS Code stopped", 1011),
          );
        }).catch((error: unknown) => {
          log.error("Unable to close stopped VS Code preview", { error: String(error) });
        });
      }
      ws.send(JSON.stringify({
        type: "ready",
        previewId: preview.config.id,
        targetKind: preview.config.targetKind,
        workspaceId: preview.config.workspaceId,
        ...(codeServer ? { code: { directory: codeServer.directory, remotePort: codeServer.port } } : {}),
      }));
    } catch (error) {
      if (ws.data.previewBridgeSessionId) {
        await this.closePreview(ws.data.previewBridgeSessionId, "Preview startup failed");
      }
      controller.abort(error);
      throw error;
    }
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

    if (runtime.requests.size >= 256) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Too many active preview requests" }));
      return;
    }
    const controller = new AbortController();
    const request = {
      controller,
      creditBytes: message.responseFlowControl === true ? PREVIEW_RESPONSE_WINDOW_BYTES : undefined,
      lastAcknowledgedAt: Date.now(),
    };
    runtime.requests.set(message.streamId, request);
    try {
      const targetUrl = resolvePreviewDestination(runtime, message.path);
      const headers = buildUpstreamHeaders(message.headers, runtime);
      const response = await fetch(targetUrl, {
        decompress: false,
        method: message.method,
        headers,
        body: message.body ? Buffer.from(decodeBase64(message.body)) : undefined,
        redirect: "manual",
        signal: controller.signal,
        tls: runtime.upstreamTls,
      });
      ws.send(JSON.stringify({
        type: "response.start",
        streamId: message.streamId,
        status: response.status,
        headers: rewritePreviewResponseHeaders(response.headers, runtime),
      }));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.byteLength; offset += PREVIEW_RESPONSE_CHUNK_BYTES) {
              const chunk = value.subarray(offset, offset + PREVIEW_RESPONSE_CHUNK_BYTES);
              const waitingSince = Date.now();
              while (
                (request.creditBytes !== undefined && request.creditBytes < chunk.byteLength)
                || (ws.getBufferedAmount?.() ?? 0) > 512 * 1024
              ) {
                controller.signal.throwIfAborted();
                if (Date.now() - Math.max(waitingSince, request.lastAcknowledgedAt) > 30_000) {
                  throw new Error("Preview response backpressure timed out");
                }
                await Bun.sleep(10);
              }
              controller.signal.throwIfAborted();
              if (request.creditBytes !== undefined) request.creditBytes -= chunk.byteLength;
              ws.send(JSON.stringify({
                type: "response.body",
                streamId: message.streamId,
                body: encodeBase64(chunk),
              }));
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      ws.send(JSON.stringify({ type: "response.end", streamId: message.streamId }));
    } catch (error) {
      if (!controller.signal.aborted) {
        ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: getBridgeErrorMessage(error) }));
      }
    } finally {
      controller.abort();
      runtime.requests.delete(message.streamId);
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
      if (runtime.webSocketForward) {
        targetUrl.protocol = "ws:";
        targetUrl.hostname = LOCAL_TUNNEL_HOST;
        targetUrl.port = String(runtime.webSocketForward.localPort);
      }
      const sockets = this.getUpstreamSocketMap(previewId);
      if (sockets.size >= 64 || sockets.has(message.streamId)) {
        throw new DomainError("preview_limit_exceeded", "Too many active preview WebSocket connections.");
      }
      const upstream = createUpstreamWebSocket(targetUrl, buildUpstreamHeaders(message.headers, runtime));
      const upstreamState: UpstreamWebSocketState = { socket: upstream, queuedMessages: [], queuedBytes: 0 };
      sockets.set(message.streamId, upstreamState);
      const isActive = () => this.getOwnedRuntime(ws, previewId) === runtime
        && !this.closing.has(previewId)
        && this.upstreamSockets.get(previewId)?.get(message.streamId) === upstreamState;

      upstream.addEventListener("open", () => {
        if (!isActive()) return;
        for (const queuedMessage of upstreamState.queuedMessages.splice(0)) {
          upstream.send(queuedMessage);
        }
        upstreamState.queuedBytes = 0;
      });
      upstream.binaryType = "arraybuffer";
      upstream.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
        if (!isActive()) return;
        const body = typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
        ws.send(JSON.stringify({
          type: "websocket.message",
          streamId: message.streamId,
          body: encodeBase64(body),
          binary: typeof event.data !== "string",
        } satisfies PreviewBridgeWebSocketMessage));
      });
      upstream.addEventListener("close", (event: CloseEvent) => {
        if (!isActive()) return;
        sockets.delete(message.streamId);
        ws.send(JSON.stringify({
          type: "websocket.close",
          streamId: message.streamId,
          code: event.code,
          reason: event.reason,
        } satisfies PreviewBridgeWebSocketCloseMessage));
      });
      upstream.addEventListener("error", () => {
        if (!isActive()) return;
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
    if (upstream.queuedBytes + upstream.socket.bufferedAmount + body.byteLength > 8 * 1024 * 1024) {
      this.handleWebSocketClose(ws, { type: "websocket.close", streamId: message.streamId, code: 1009, reason: "Preview WebSocket buffer limit exceeded" });
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview WebSocket buffer limit exceeded" }));
      return;
    }
    const payload = message.binary
      ? toArrayBuffer(body)
      : new TextDecoder().decode(body);
    if (upstream.socket.readyState === WebSocket.OPEN) {
      upstream.socket.send(payload);
      return;
    }
    if (upstream.socket.readyState === WebSocket.CONNECTING) {
      upstream.queuedBytes += body.byteLength;
      upstream.queuedMessages.push(payload);
    } else {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview upstream WebSocket is closed" }));
    }
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
      upstream.socket.close(previewWebSocketCloseCode(message.code), message.reason);
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
    this.upstreamSockets.delete(previewId);
    for (const socket of sockets.values()) {
      if (socket.socket.readyState < WS_READY_STATE_CLOSING) {
        socket.socket.close(1000, "Preview bridge closed");
      }
    }
  }

  private async reconcileStalePreviews(): Promise<void> {
    const previews = await listPreviewSessionsByStatuses(["active", "closing", "failed"]);
    for (const preview of previews) {
      if (this.runtimes.has(preview.config.id) || this.registering.has(preview.config.id)) continue;
      try {
        if (!preview.config.codeCleanup) {
          log.warn("Closing stale preview without durable code ownership; host resources cannot be inferred", { previewId: preview.config.id });
        }
        await this.closePreviewOnce(preview.config.id, "Preview closed after controller restart", 1001);
      } catch (error) {
        // Keep each failed cleanup independently actionable without blocking
        // reconciliation of the remaining previews.
        if (!(error instanceof DomainError && error.code === "code_cleanup_failed")) {
          log.warn("Preview startup reconciliation could not save cleanup state", { previewId: preview.config.id, error: String(error) });
        }
      }
    }
  }

  private async cleanupSavedCodeSession(preview: PreviewSession): Promise<void> {
    const ownership = preview.config.codeCleanup;
    if (!ownership) return;
    if (ownership.kind === "invalid") {
      throw new DomainError("code_cleanup_failed", "The saved VS Code resource ownership is invalid; cleanup requires intervention.");
    }
    const executor = await executionHostService.getCommandExecutor(preview.config.executionHostBinding, {
      operationId: preview.config.id,
      directory: "/",
    });
    try {
      await cleanupCodeSession({ executor, id: preview.config.id, ownership });
    } finally {
      closeCommandExecutor(executor);
    }
  }

  private async retainPendingCleanup(preview: PreviewSession, error: unknown): Promise<void> {
    const pending: PreviewSession = {
      config: { ...preview.config, updatedAt: new Date().toISOString() },
      state: {
        ...preview.state,
        status: "closing",
        error: "Cleanup is pending. Retry closing this preview when its original execution host is available.",
      },
    };
    await savePreviewSession(pending);
    log.warn("Preview resources retained for cleanup retry", { previewId: preview.config.id, error: String(error) });
    previewEventEmitter.emit({
      type: "preview.failed", previewId: preview.config.id, workspaceId: preview.config.workspaceId,
      executionHostBinding: preview.config.executionHostBinding, preview: pending,
      error: pending.state.error!, timestamp: pending.config.updatedAt,
    });
  }

}

export const previewSessionManager = new PreviewSessionManager();
