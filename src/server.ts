/**
 * Main server startup for the Clanky web application.
 */

import type { Server } from "bun";
import { homedir } from "node:os";
import { CLANKY_WEB_OPTIONS } from "./web-client-options";
import { createWebAppServer, defineRoutes, getRequestOriginInfo, log, readRuntimeConfig, sqliteWebAppStore, type WebAppServer, type WebAppWebSocketData } from "@pablozaiden/webapp/server";
import { apiRoutes } from "./api";
import {
  meshControllerInternalRoutes,
  meshWorkerInternalRoutes,
} from "./api/mesh-internal";
import { authorizedRawWebSocketUpgrade } from "./api/raw-websocket-upgrade";
import { websocketHandlers } from "./api/websocket";
import { getDataDir, initializeDatabase } from "./persistence/database";
import { harnessSecretFiles } from "./core/harness-secret-files";
import { ensureLocalMeshNodeIdentity } from "./persistence/mesh-node-identity";
import { resetStaleTasks } from "./persistence/tasks";
import { resetStaleChats } from "./persistence/chats";
import { runForEachActiveUser } from "./core/background-users";
import { backendManager } from "./core/backend-manager";
import { taskManager } from "./core/task-manager";
import { chatManager } from "./core/chat-manager";
import type {
  MacWorkerPermissionPreflightRequest,
  MacWorkerPermissionPreflightWorkerMessage,
} from "./core/macos-worker-permissions";
import { isServerEvent, type ServerEvent } from "./core/backend/backend-state";
import { getServerStartupMessages } from "./core/server-config";
import { pushedTaskMonitor } from "./core/pushed-task-monitor";
import { agentScheduler } from "./core/agent-scheduler";
import { getAppConfig } from "./core/config";
import { managedCredentialService } from "./core/managed-credential-service";
import { provisioningManager } from "./core/provisioning-manager";
import { workerUpdateManager } from "./core/worker-update-manager";
import { meshManager } from "./core/mesh-manager";
import {
  agentEventEmitter,
  chatEventEmitter,
  provisioningEventEmitter,
  terminalSessionEventEmitter,
  taskEventEmitter,
  previewEventEmitter,
  meshStateEventEmitter,
  harnessEventEmitter,
  subagentEventEmitter,
  clientActionEventEmitter,
  workerUpdateEventEmitter,
} from "./core/event-emitter";
import type { EventContext } from "./core/event-emitter";
import {
  createClankyRealtimePublisher,
  publishClankyDomainEvent,
  type ClankyDomainEvent,
} from "./realtime";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { CLANKY_VERSION } from "./version";
import { resolveTerminal } from "./core/terminal-connection";
import { terminalSessionManager } from "./core/terminal-session-manager";
import { isDomainError } from "./domain/domain-error";
import { meshTerminalGateway } from "./core/mesh-terminal-gateway";
import { meshTcpTunnelGateway } from "./core/mesh-tcp-tunnel-gateway";
import { closeAllMeshTerminalConnections } from "./core/terminal";
import { meshHarnessGateway } from "./core/mesh-harness-gateway";
import { meshAcpGateway } from "./core/mesh-acp-gateway";
import { runWithCurrentUser } from "./context/user-context";
import {
  configureMeshRuntime,
  getMeshWorkerDirectory,
} from "./core/mesh-runtime";
import { getMeshTransport } from "./core/mesh-transport-config";
import { isSecureMeshRequest } from "./core/mesh-transport-security";
import { setLocalMeshExecutionConfiguration } from "./persistence/mesh-node-identity";
import {
  ensureMeshWorkerTlsIdentity,
  getMeshWorkerServerTls,
} from "./persistence/mesh-worker-tls";
import {
  MESH_RELAY_DESCRIPTOR_PATH,
  type MeshControllerWellKnownDescriptor,
} from "./shared/mesh-relay";
import {
  MESH_RUNTIME_SNAPSHOT_HEADER,
  MESH_RUNTIME_SNAPSHOT_VERSION,
} from "./shared/mesh";
import {
  MESH_BINARY_VERSION_HEADER,
  MESH_PROTOCOL_VERSION,
  meshProtocolProjection,
  MESH_PROTOCOL_VERSION_HEADER,
  MESH_PROTOCOL_VERSIONS_HEADER,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  negotiateMeshProtocolVersion,
  parseMeshProtocolVersionsHeader,
  serializeMeshProtocolVersions,
} from "./shared/mesh-protocol";
import { getLocalMeshProtocolMetadata } from "./core/mesh-protocol-version";
import { controllerRelayService } from "./core/controller-relay-service";
import { liveVoiceManager } from "./core/live-voice-manager";
import { startChatTrashMaintenance, stopChatTrashMaintenance, sweepChatTrash } from "./core/chat-trash-maintenance";
import { previewSessionManager } from "./core/preview-session-manager";
import { workerRelayService } from "./core/worker-relay-service";
import { meshHealthService } from "./core/mesh-health-service";
import { ClankyOperationService } from "./core/clanky-operation-service";
import { configureLiveVoiceApi } from "./api/live-voice";
import { createVoiceOperationAuthority } from "./server/voice-operation-adapter";
import { workspaceClientController } from "./core/workspace-client-controller";
import { workspaceConnections } from "./core/workspace-connections";
import { configureWorkspaceClientGateway } from "./api/workspace-client-gateway";
import { workspaceClientSockets } from "./api/workspace-client-sockets";
import { workspaceDirectRoutes, workspaceDirectHandlers, stopWorkspaceDirect } from "./api/workspace-direct";
import { remoteTerminalProxy } from "./api/workspace-socket-proxy";
import { workspaceRealtimeSources } from "./api/workspace-realtime-source";
import { ControlServer } from "./server/control-server";
import { mcpRoutes } from "./api/control";

const PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS = 0;
const WORKSPACE_WORKER_RECONCILE_INTERVAL_MS = 30_000;
const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const MESH_WORKER_CONTROL_ROUTE_METHODS = {
  "/api/mesh/status": ["GET"],
  "/api/mesh/instance-name": ["POST"],
  "/api/mesh/endpoint": ["POST"],
  "/api/mesh/enroll": ["POST"],
} as const satisfies Record<string, readonly string[]>;

let app: WebAppServer<ClankyRealtimeEvent> | undefined;
let appMeshWorkerMode: boolean | undefined;
let appRelayOnlyMode: boolean | undefined;
let appApiOnlyMode: boolean | undefined;
let realtimeBridgeUnsubscribers: Array<() => void> | undefined;
let workspaceWorkerReconcileTimer: Timer | undefined;
let workspaceWorkerReconcileRunning = false;

function normalizeLocalManagedCredentialHost(host: string): string | undefined {
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (normalizedHost === "127.0.0.1" || normalizedHost === "localhost") {
    return normalizedHost;
  }
  if (
    normalizedHost === "::"
    || normalizedHost === "[::]"
    || normalizedHost === "::1"
    || normalizedHost === "[::1]"
  ) {
    return "::1";
  }
  return undefined;
}

export function getLocalManagedCredentialBaseUrl(host: string, port: number): string | undefined {
  const normalizedHost = normalizeLocalManagedCredentialHost(host);
  if (!normalizedHost || port <= 0) {
    return undefined;
  }
  const formattedHost = normalizedHost === "::1" ? `[${normalizedHost}]` : normalizedHost;
  return `http://${formattedHost}:${String(port)}`;
}

function registerClankyRealtimeBridge(appServer: WebAppServer<ClankyRealtimeEvent>): void {
  if (realtimeBridgeUnsubscribers) {
    return;
  }
  const publisher = createClankyRealtimePublisher(appServer.realtime);
  const publishEvent = (event: ClankyDomainEvent | ServerEvent, context: EventContext): void => {
    if (isServerEvent(event)) {
      return;
    }
    if (!context.userId) {
      log.warn("Skipping user realtime event without an owner context", {
        eventType: event.type,
      });
      return;
    }
    publishClankyDomainEvent(publisher, event, { userId: context.userId });
  };
  realtimeBridgeUnsubscribers = [
    taskEventEmitter.subscribe(publishEvent),
    chatEventEmitter.subscribe(publishEvent),
    agentEventEmitter.subscribe(publishEvent),
    terminalSessionEventEmitter.subscribe(publishEvent),
    provisioningEventEmitter.subscribe(publishEvent),
    previewEventEmitter.subscribe(publishEvent),
    meshStateEventEmitter.subscribe(publishEvent),
    harnessEventEmitter.subscribe(publishEvent),
    subagentEventEmitter.subscribe(publishEvent),
    clientActionEventEmitter.subscribe(publishEvent),
    workerUpdateEventEmitter.subscribe(publishEvent),
  ];
}

async function reconcileStartupState(): Promise<void> {
  await backendManager.initialize();

  let staleTasksReset = 0;
  let staleChatsReset = 0;
  let staleManagedContextsRevoked = 0;
  await runForEachActiveUser(async (user) => {
    staleTasksReset += await resetStaleTasks();
    staleChatsReset += await resetStaleChats();
    const resetTerminals = terminalSessionManager.reconcileStartupState();
    if (resetTerminals > 0) log.info("Reconciled terminal connections during startup", { count: resetTerminals });
    staleManagedContextsRevoked += await managedCredentialService.reconcileCurrentUser();
    await meshManager.reconcileWorkspaceWorkerEnrollments(user.id);
    await provisioningManager.reconcileDedicatedWorkerStartupState();
    workerUpdateManager.reconcileStartupState();
    await previewSessionManager.initialize();
  });
  if (staleTasksReset > 0) {
    log.info(`Reconciled ${staleTasksReset} stale tasks during startup`);
  }
  if (staleChatsReset > 0) {
    log.info(`Reconciled ${staleChatsReset} stale chats during startup`);
  }
  if (staleManagedContextsRevoked > 0) {
    log.info(`Revoked ${staleManagedContextsRevoked} stale managed execution contexts during startup`);
  }
  await sweepChatTrash();
}

async function reconcileWorkspaceWorkerEnrollments(): Promise<void> {
  if (workspaceWorkerReconcileRunning) {
    return;
  }
  workspaceWorkerReconcileRunning = true;
  try {
    await runForEachActiveUser(async (user) => {
      await meshManager.reconcileWorkspaceWorkerEnrollments(user.id);
    });
  } catch (error) {
    log.error("Workspace worker enrollment reconciliation failed", {
      error: String(error),
    });
  } finally {
    workspaceWorkerReconcileRunning = false;
  }
}

function startWorkspaceWorkerReconciliation(): void {
  if (workspaceWorkerReconcileTimer) {
    return;
  }
  workspaceWorkerReconcileTimer = setInterval(() => {
    void reconcileWorkspaceWorkerEnrollments();
  }, WORKSPACE_WORKER_RECONCILE_INTERVAL_MS);
  workspaceWorkerReconcileTimer.unref?.();
}

function stopWorkspaceWorkerReconciliation(): void {
  if (!workspaceWorkerReconcileTimer) {
    return;
  }
  clearInterval(workspaceWorkerReconcileTimer);
  workspaceWorkerReconcileTimer = undefined;
}

function startMacWorkerPermissionPreflight(): void {
  // Native FFI calls are synchronous; keep them off the Mesh server's event loop.
  let worker: Worker | undefined;
  let workerSourceUrl: string | undefined;
  const releaseWorkerSource = (): void => {
    if (workerSourceUrl) {
      URL.revokeObjectURL(workerSourceUrl);
      workerSourceUrl = undefined;
    }
  };

  try {
    const workerSource = typeof __CLANKY_MACOS_WORKER_PERMISSION_PREFLIGHT_SOURCE__ === "string"
      ? __CLANKY_MACOS_WORKER_PERMISSION_PREFLIGHT_SOURCE__
      : undefined;
    const workerUrl = workerSource
      ? (workerSourceUrl = URL.createObjectURL(
          new Blob([workerSource], { type: "text/javascript" }),
        ))
      : new URL("./core/macos-worker-permissions.worker.ts", import.meta.url);
    worker = new Worker(workerUrl, {
      name: "clanky-macos-worker-permission-preflight",
      ref: false,
    });
    const permissionWorker = worker;
    permissionWorker.onmessage = (
      event: MessageEvent<MacWorkerPermissionPreflightWorkerMessage>,
    ) => {
      const message = event.data;
      if (message.type === "output") {
        log.info(message.message);
      } else if (message.type === "error") {
        log.error("macOS worker permission preflight failed", {
          error: message.error,
        });
        releaseWorkerSource();
      } else {
        releaseWorkerSource();
      }
    };
    permissionWorker.onerror = (event) => {
      log.error("macOS worker permission preflight failed", {
        error: event.message,
      });
      permissionWorker.terminate();
      releaseWorkerSource();
    };
    const request: MacWorkerPermissionPreflightRequest = {
      homeDirectory: process.env["HOME"]?.trim() || homedir(),
    };
    permissionWorker.postMessage(request);
  } catch (error) {
    worker?.terminate();
    releaseWorkerSource();
    log.error("Unable to start macOS worker permission preflight", {
      error: String(error),
    });
  }
}

async function initializeMeshWorkerRuntime(): Promise<void> {
  if (process.platform === "darwin") {
    startMacWorkerPermissionPreflight();
  }
  await backendManager.initialize();
}

async function completeStartup(
  server: Server<WebAppWebSocketData>,
  options: { startBackgroundWorkers?: boolean } = {},
): Promise<void> {
  const appServer = app;
  if (!appServer) {
    throw new Error("Clanky web app server is unavailable during startup");
  }
  const serverUrl = new URL(server.url);
  const localManagedCredentialBaseUrl = getLocalManagedCredentialBaseUrl(
    serverUrl.hostname,
    Number(serverUrl.port),
  );
  if (!appServer.config.publicBaseUrl && localManagedCredentialBaseUrl) {
    managedCredentialService.configure(appServer.store, {
      localBaseUrl: localManagedCredentialBaseUrl,
    });
  }
  if (options.startBackgroundWorkers !== false) {
    pushedTaskMonitor.start();
    agentScheduler.start();
    startWorkspaceWorkerReconciliation();
    startChatTrashMaintenance();
  }

  for (const message of getServerStartupMessages({
    host: appServer.config.host,
    port: appServer.config.port,
    protocol: serverUrl.protocol === "https:" ? "https" : "http",
    hostSource: process.env["CLANKY_HOST"]?.trim() ? "CLANKY_HOST" : "default",
    sameOriginProtection: { disabled: appServer.config.sameOriginDisabled },
  })) {
    log.info(message);
  }
  log.info(`Clanky server running at ${server.url}`);
}

function stopBackgroundWorkers(): void {
  pushedTaskMonitor.stop();
  agentScheduler.stop();
  stopWorkspaceWorkerReconciliation();
}

export const routes = defineRoutes<ClankyRealtimeEvent>({
  ...mcpRoutes,
  [MESH_RELAY_DESCRIPTOR_PATH]: {
    auth: "public",
    sameOrigin: "never",
    description: "Describe this Clanky Mesh controller and its public identity.",
    tags: ["mesh", "discovery"],
    operations: { GET: { automation: { policy: "excluded", reason: "Mesh wire-protocol discovery, not an app operation." } } },
    async GET(req): Promise<Response> {
      if (!isSecureMeshRequest(req)) {
        return new Response("Mesh 7 requires HTTPS", { status: 406 });
      }
      const identity = await ensureLocalMeshNodeIdentity();
      const protocol = getLocalMeshProtocolMetadata();
      const requestedVersions = parseMeshProtocolVersionsHeader(
        req.headers.get(MESH_PROTOCOL_VERSIONS_HEADER),
      );
      const negotiatedVersion = negotiateMeshProtocolVersion(
        [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
        requestedVersions,
      );
      const descriptor: MeshControllerWellKnownDescriptor = {
        role: "controller",
        ...meshProtocolProjection(negotiatedVersion ?? MESH_PROTOCOL_VERSION),
        nodeId: identity.nodeId,
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        binaryVersion: protocol.binaryVersion!,
        negotiatedProtocolVersion: negotiatedVersion,
      };
      return Response.json(descriptor, {
        headers: {
          [MESH_RUNTIME_SNAPSHOT_HEADER]: String(
            MESH_RUNTIME_SNAPSHOT_VERSION,
          ),
          [MESH_BINARY_VERSION_HEADER]: protocol.binaryVersion ?? "",
          [MESH_PROTOCOL_VERSIONS_HEADER]: serializeMeshProtocolVersions(
            protocol.supportedProtocolVersions,
          ),
          [MESH_PROTOCOL_VERSION_HEADER]: String(
            negotiatedVersion ?? MESH_PROTOCOL_VERSION,
          ),
        },
      });
    },
  },
  "/api/previews/bridge": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for a workspace or direct server preview.",
    operations: { GET: { automation: { policy: "excluded", reason: "Raw websocket transport." } } },
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      return authorizedRawWebSocketUpgrade(user.id, () => {
        ctx.server?.timeout(req, PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS);
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            previewBridgeMode: true,
            previewBridgeUserId: user.id,
            user,
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      });
    },
  },
  "/api/terminal": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for a terminal session.",
    operations: { GET: { automation: { policy: "excluded", reason: "Raw terminal websocket transport." } } },
    async GET(req, ctx): Promise<Response | undefined> {
      const user = ctx.requireUser();
      const terminalSessionId = new URL(req.url).searchParams.get("terminalSessionId")?.trim();
      if (!terminalSessionId) {
        return new Response("terminalSessionId is required", { status: 400 });
      }
      try {
        const workspaceProxy = remoteTerminalProxy(terminalSessionId, user);
        if (workspaceProxy) {
          return authorizedRawWebSocketUpgrade(user.id, () => {
            const upgraded = ctx.server?.upgrade(req, {
              data: { webappSocketHandler: "clanky", terminalSessionId, terminalMode: true, workspaceProxy, user },
            });
            if (!upgraded) workspaceProxy.close();
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
          });
        }
        const resolved = await runWithCurrentUser(
          user,
          async () => await resolveTerminal(terminalSessionId),
        );
        return authorizedRawWebSocketUpgrade(user.id, () => {
          const upgraded = ctx.server?.upgrade(req, {
            data: {
              webappSocketHandler: "clanky",
              terminalSessionId,
              terminalTransport: resolved.executionHostBinding.host.kind,
              terminalMode: true,
              user,
            },
          });
          return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        });
      } catch (error) {
        if (isDomainError(error)) {
          const status = error.code === "terminal_session_not_found"
            || error.code === "workspace_not_found"
            ? 404
            : 409;
          return Response.json({ error: error.code, message: error.message }, { status });
        }
        throw error;
      }
    },
  },
  ...apiRoutes,
  ...workspaceDirectRoutes,
  ...meshControllerInternalRoutes,
});

export const meshWorkerRoutes = defineRoutes<ClankyRealtimeEvent>({
  ...meshWorkerInternalRoutes,
  "/api/mesh/status": apiRoutes["/api/mesh/status"]!,
  "/api/mesh/instance-name": apiRoutes["/api/mesh/instance-name"]!,
  "/api/mesh/endpoint": apiRoutes["/api/mesh/endpoint"]!,
  "/api/mesh/enroll": apiRoutes["/api/mesh/enroll"]!,
});

export function isMeshWorkerRequestAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") {
    return request.method === "GET";
  }
  if (path.startsWith("/api/mesh/internal/")) {
    const route = meshWorkerInternalRoutes[path];
    const method = ROUTE_METHODS.find((candidate) => candidate === request.method);
    return method !== undefined && Boolean(route?.[method]);
  }
  const methods = MESH_WORKER_CONTROL_ROUTE_METHODS[
    path as keyof typeof MESH_WORKER_CONTROL_ROUTE_METHODS
  ];
  return methods?.some((method) => method === request.method) ?? false;
}

export async function getWebAppServer(
  options: {
    meshWorker?: boolean;
    relayOnly?: boolean;
    workerDirectory?: string;
    workerExecutionEnabled?: boolean;
    apiOnly?: boolean;
    workerEndpoint?: string;
    rotateWorkerTls?: boolean;
  } = {},
): Promise<WebAppServer<ClankyRealtimeEvent>> {
  const meshWorker = options.meshWorker ?? false;
  const relayOnly = options.relayOnly ?? false;
  const apiOnly = options.apiOnly ?? false;
  if (meshWorker && apiOnly) {
    throw new Error("API-only serving applies to controllers, not restricted Mesh workers.");
  }
  if (relayOnly && !meshWorker) {
    throw new Error("Relay-only mode requires Mesh worker mode.");
  }
  if (
    relayOnly
    && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(
      readRuntimeConfig({
        appName: "Clanky",
        envPrefix: "CLANKY",
        appDirectoryName: ".clanky",
      }).host.trim().toLowerCase(),
    )
  ) {
    throw new Error("A relay-only Mesh worker must listen on a loopback host.");
  }
  if (app) {
    if (
      appMeshWorkerMode !== meshWorker
      || appRelayOnlyMode !== relayOnly
      || appApiOnlyMode !== apiOnly
    ) {
      throw new Error(
        `Clanky server is already initialized with meshWorker=${String(appMeshWorkerMode)}, relayOnly=${String(appRelayOnlyMode)}, apiOnly=${String(appApiOnlyMode)} and cannot be reused with meshWorker=${String(meshWorker)}, relayOnly=${String(relayOnly)}, apiOnly=${String(apiOnly)}`,
      );
    }
    return app;
  }
  await configureMeshRuntime({
    meshWorker,
    workerDirectory: options.workerDirectory,
    workerExecutionEnabled: options.workerExecutionEnabled,
    relayOnly,
  });
  await initializeDatabase();
  await harnessSecretFiles.initialize();
  if (meshWorker) {
    process.env["CLANKY_WORKER_INSTANCE_ID"] = crypto.randomUUID();
    process.env["CLANKY_WORKER_RUNNING_VERSION"] = CLANKY_VERSION;
    log.info("Loading Mesh worker node identity");
  }
  const identity = await ensureLocalMeshNodeIdentity();
  if (meshWorker) {
    log.info("Mesh worker node identity loaded");
  }
  let workerTls: Bun.TLSOptions | undefined;
  if (meshWorker) {
    const workerEndpoint = options.workerEndpoint ?? identity.meshEndpoint;
    if (!relayOnly) {
      if (!workerEndpoint) {
        throw new Error(
          "A secure Mesh worker requires a configured Mesh endpoint before the server starts.",
        );
      }
      if (getMeshTransport(workerEndpoint) !== "https") {
        throw new Error(
          "A Mesh worker requires an HTTPS Mesh endpoint.",
        );
      }
      log.info("Loading Mesh worker TLS identity");
      const tlsIdentity = await ensureMeshWorkerTlsIdentity(workerEndpoint, {
        rotate: options.rotateWorkerTls,
      });
      log.info("Mesh worker TLS identity loaded");
      workerTls = getMeshWorkerServerTls(tlsIdentity);
    }
    log.info("Configuring Mesh worker execution");
    await setLocalMeshExecutionConfiguration({
      acceptRemoteExecution: options.workerExecutionEnabled ?? true,
      repositoriesBasePath: getMeshWorkerDirectory(),
      preferredModel: null,
    });
    log.info("Mesh worker execution configured");
  }
  const dataDir = getDataDir();
  if (meshWorker && process.env["CLANKY_DISABLE_PASSKEY"] === "true") {
    throw new Error("Mesh-worker mode cannot be combined with CLANKY_DISABLE_PASSKEY");
  }
  if (meshWorker) {
    log.info("Creating Mesh worker application server");
  }
  const store = sqliteWebAppStore({ dataDir, fileName: "clanky.db" });
  if (!meshWorker && !Bun.isStandaloneExecutable) {
    const { writeClientOperationCatalog } = await import("./client-operation-catalog");
    await writeClientOperationCatalog();
  }
  const controlRuntime = readRuntimeConfig({
    appName: "Clanky", envPrefix: "CLANKY", appDirectoryName: ".clanky",
  });
  let controlBaseUrl = controlRuntime.publicBaseUrl
    ?? getLocalManagedCredentialBaseUrl(controlRuntime.host, controlRuntime.port);
  const controlServer = meshWorker ? undefined : new ControlServer({
    store, getBaseUrl: () => controlBaseUrl,
  });
  app = createWebAppServer<ClankyRealtimeEvent>({
    appName: "Clanky",
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
    web: meshWorker ? false : { ...CLANKY_WEB_OPTIONS, mode: apiOnly ? "auth" : "app" },
    ...(meshWorker ? { requestFilter: isMeshWorkerRequestAllowed } : {}),
    ...(workerTls ? { server: { tls: workerTls } } : {}),
    version: CLANKY_VERSION,
    store,
    auth: meshWorker
      ? { passkeys: false, apiKeys: true, deviceAuth: false }
      : { passkeys: true, apiKeys: true, deviceAuth: true, ...(controlServer?.oauth ? { oauth: controlServer.oauth } : {}) },
    ...(meshWorker ? {} : { realtime: { path: "/api/ws" } }),
    routes: meshWorker ? meshWorkerRoutes : routes,
    websockets: {
      clanky: websocketHandlers as never,
      workspaceDirect: workspaceDirectHandlers as never,
    },
    lifecycle: {
      beforeStart: meshWorker
        ? initializeMeshWorkerRuntime
        : reconcileStartupState,
      afterStart: async (server) => {
        controlBaseUrl = app?.config.publicBaseUrl
          ?? (server.port === undefined ? undefined : getLocalManagedCredentialBaseUrl(controlRuntime.host, server.port));
        await completeStartup(server, {
          startBackgroundWorkers: !meshWorker,
        });
        const appServer = app;
        if (!appServer) {
          throw new Error("Clanky web app server is unavailable during relay startup");
        }
        if (meshWorker) {
          await workerRelayService.startRuntime(
            async (request) => await appServer.handleRequest(request),
          );
        } else {
          await controllerRelayService.startRuntime(
            async (request) => await appServer.handleRequest(request),
            {
              onAuthenticated: () => {
                meshHealthService.scheduleRefreshAllWorkers(
                  "controller relay authenticated",
                );
              },
              onReady: async () => {
                await runForEachActiveUser(async () => {
                  await previewSessionManager.retryPendingCleanup();
                });
              },
              openWorkspaceClientSocket: async (input) => await workspaceClientSockets.open(input),
            },
          );
          await workspaceConnections.start();
          meshHealthService.scheduleRefreshAllWorkers("controller startup");
        }
      },
      beforeStop: async () => {
        chatManager.beginShutdown();
        taskManager.beginShutdown();
        const errors: unknown[] = [];
        const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            errors.push(error);
          }
        };
        await cleanup(() => workspaceConnections.stop());
        await cleanup(() => workspaceRealtimeSources.stop());
        await cleanup(() => workspaceClientSockets.stop());
        await cleanup(stopWorkspaceDirect);
        workspaceClientController.stop();
        await cleanup(stopBackgroundWorkers);
        await cleanup(stopChatTrashMaintenance);
        await Promise.all([
          cleanup(() => previewSessionManager.closeAll()),
          cleanup(() => liveVoiceManager.closeAll()),
          cleanup(() => controlServer?.close()),
        ]);
        await cleanup(() => chatManager.shutdown());
        await cleanup(() => taskManager.shutdown());
        await cleanup(() => backendManager.shutdown());
        // Remote clients must release their sessions before relays and gateways close.
        await cleanup(() => meshWorker
          ? workerRelayService.stopRuntime()
          : controllerRelayService.stopRuntime());
        await cleanup(() => meshTerminalGateway.closeAll());
        await cleanup(() => meshTcpTunnelGateway.closeAll());
        await cleanup(closeAllMeshTerminalConnections);
        await cleanup(() => meshHarnessGateway.closeAll());
        await cleanup(() => meshAcpGateway.closeAll());
        await cleanup(() => harnessSecretFiles.close());
        if (errors.length > 0) throw new AggregateError(errors, "Clanky shutdown cleanup failed.");
      },
    },
    configResponse: (req) => {
      const publicBasePath = app ? getRequestOriginInfo(req, app.config).pathPrefix : "/";
      return {
        ...getAppConfig(),
        publicBasePath: publicBasePath === "/" ? null : publicBasePath,
      };
    },
  });
  appMeshWorkerMode = meshWorker;
  appRelayOnlyMode = relayOnly;
  appApiOnlyMode = apiOnly;
  managedCredentialService.configure(app.store, {
    publicBaseUrl: app.config.publicBaseUrl,
    localBaseUrl: getLocalManagedCredentialBaseUrl(app.config.host, app.config.port),
  });
  controlServer?.configure(app);
  if (!meshWorker) {
    const appServer = app;
    configureWorkspaceClientGateway(appServer);
    workspaceClientSockets.configure(appServer.realtime);
    workspaceRealtimeSources.configure(appServer.realtime);
    workspaceClientController.configure({
      revokeTransports: async (event) => await workspaceClientSockets.revoke(event),
      changed: (userId) => appServer.realtime.publishChanged("workspace-collaboration", { target: { userId } }),
    });
    workspaceConnections.configure({
      changed: (userId) => appServer.realtime.publishChanged("workspace-connections", { target: { userId } }),
      runtimeChanged: (runtime) => workspaceRealtimeSources.update(runtime),
      runtimeStopped: (connectionId) => workspaceRealtimeSources.remove(connectionId),
    });
    liveVoiceManager.configure(new ClankyOperationService(app.routeCatalog));
    configureLiveVoiceApi((req, ctx) => createVoiceOperationAuthority(appServer, req, ctx));
    registerClankyRealtimeBridge(app);
  }
  if (meshWorker) {
    log.info("Mesh worker application server created");
  }
  return app;
}

export async function startServer(
  options: { meshWorker?: boolean; relayOnly?: boolean; apiOnly?: boolean } = {},
): Promise<Server<WebAppWebSocketData>> {
  return await (await getWebAppServer(options)).start();
}
