/**
 * Main server startup for the Clanky web application.
 */

import type { Server } from "bun";
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import faviconPath from "./favicon.svg" with { type: "file" };
import manifestIcon192Path from "./web-app-manifest-192x192.png" with { type: "file" };
import manifestIcon512Path from "./web-app-manifest-512x512.png" with { type: "file" };
import { createWebAppServer, defineRoutes, getRequestOriginInfo, log, sqliteWebAppStore, type WebAppServer, type WebAppWebSocketData } from "@pablozaiden/webapp/server";
import { apiRoutes } from "./api";
import { meshInternalRoutes } from "./api/mesh-internal";
import { authorizedRawWebSocketUpgrade } from "./api/raw-websocket-upgrade";
import { websocketHandlers } from "./api/websocket";
import { getDataDir, initializeDatabase } from "./persistence/database";
import { ensureLocalMeshNodeIdentity } from "./persistence/mesh-node-identity";
import { resetStaleTasks } from "./persistence/tasks";
import { runForEachActiveUser } from "./core/background-users";
import { backendManager } from "./core/backend-manager";
import { isServerEvent, type ServerEvent } from "./core/backend/backend-state";
import { getServerStartupMessages } from "./core/server-config";
import { pushedTaskMonitor } from "./core/pushed-task-monitor";
import { agentScheduler } from "./core/agent-scheduler";
import { getAppConfig } from "./core/config";
import { managedCredentialService } from "./core/managed-credential-service";
import { provisioningManager } from "./core/provisioning-manager";
import {
  agentEventEmitter,
  chatEventEmitter,
  provisioningEventEmitter,
  sshServerSessionEventEmitter,
  terminalSessionEventEmitter,
  taskEventEmitter,
  previewEventEmitter,
  meshStateEventEmitter,
} from "./core/event-emitter";
import type { EventContext } from "./core/event-emitter";
import {
  createClankyRealtimePublisher,
  publishClankyDomainEvent,
  type ClankyDomainEvent,
  type ClankyRealtimeEvent,
} from "./realtime";
import { installRealtimeHeartbeat } from "./realtime-heartbeat";
import { CLANKY_VERSION } from "./version";
import { resolveWorkspaceTerminal } from "./core/workspace-terminal-connection";
import { isDomainError } from "./core/domain-error";
import { meshTerminalGateway } from "./core/mesh-terminal-gateway";
import { meshTcpTunnelGateway } from "./core/mesh-tcp-tunnel-gateway";
import { closeAllMeshTerminalConnections } from "./core/terminal";
import { runWithCurrentUser } from "./core/user-context";

const PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS = 0;
const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const MESH_WORKER_CONTROL_ROUTE_METHODS = {
  "/api/mesh/status": ["GET"],
  "/api/mesh/instance-name": ["POST"],
  "/api/mesh/endpoint": ["POST"],
  "/api/mesh/execution": ["POST"],
  "/api/mesh/pairing-requests": ["POST"],
} as const satisfies Record<string, readonly string[]>;

let app: WebAppServer<ClankyRealtimeEvent> | undefined;
let appMeshWorkerMode: boolean | undefined;
let realtimeBridgeUnsubscribers: Array<() => void> | undefined;
let realtimeHeartbeatCleanup: (() => void) | undefined;

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
    sshServerSessionEventEmitter.subscribe(publishEvent),
    terminalSessionEventEmitter.subscribe(publishEvent),
    provisioningEventEmitter.subscribe(publishEvent),
    previewEventEmitter.subscribe(publishEvent),
    meshStateEventEmitter.subscribe(publishEvent),
  ];
}

function unregisterClankyRealtimeBridge(): void {
  for (const unsubscribe of realtimeBridgeUnsubscribers ?? []) {
    unsubscribe();
  }
  realtimeBridgeUnsubscribers = undefined;
}

async function reconcileStartupState(): Promise<void> {
  await backendManager.initialize();

  let staleTasksReset = 0;
  let staleManagedContextsRevoked = 0;
  await runForEachActiveUser(async () => {
    staleTasksReset += await resetStaleTasks();
    staleManagedContextsRevoked += await managedCredentialService.reconcileCurrentUser();
    provisioningManager.reconcileStartupState();
  });
  if (staleTasksReset > 0) {
    log.info(`Reconciled ${staleTasksReset} stale tasks during startup`);
  }
  if (staleManagedContextsRevoked > 0) {
    log.info(`Revoked ${staleManagedContextsRevoked} stale managed execution contexts during startup`);
  }
}

async function initializeMeshWorkerRuntime(): Promise<void> {
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
  }

  for (const message of getServerStartupMessages({
    host: appServer.config.host,
    port: appServer.config.port,
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
}

export const routes = defineRoutes<ClankyRealtimeEvent>({
  "/api/previews/bridge": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for a workspace preview.",
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      return authorizedRawWebSocketUpgrade(user.id, () => {
        ctx.server?.timeout(req, PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS);
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            previewBridgeMode: true,
            user,
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      });
    },
  },
  "/api/ssh-terminal": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for an SSH terminal.",
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      const url = new URL(req.url);
      const sshServerSessionId = url.searchParams.get("sshServerSessionId") ?? undefined;

      if (!sshServerSessionId) {
        return new Response("sshServerSessionId is required", { status: 400 });
      }

      return authorizedRawWebSocketUpgrade(user.id, () => {
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            sshServerSessionId,
            terminalMode: true,
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
    description: "Open the raw websocket bridge for a workspace terminal.",
    async GET(req, ctx): Promise<Response | undefined> {
      const user = ctx.requireUser();
      const terminalSessionId = new URL(req.url).searchParams.get("terminalSessionId")?.trim();
      if (!terminalSessionId) {
        return new Response("terminalSessionId is required", { status: 400 });
      }
      try {
        const resolved = await runWithCurrentUser(
          user,
          async () => await resolveWorkspaceTerminal(terminalSessionId),
        );
        return authorizedRawWebSocketUpgrade(user.id, () => {
          const upgraded = ctx.server?.upgrade(req, {
            data: {
              webappSocketHandler: "clanky",
              workspaceTerminalSessionId: terminalSessionId,
              workspaceTerminalTransport: resolved.transport,
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
  "/api/vnc": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for a VNC session.",
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      const url = new URL(req.url);
      const vncSessionId = url.searchParams.get("vncSessionId") ?? undefined;
      if (!vncSessionId) {
        return new Response("vncSessionId is required", { status: 400 });
      }
      return authorizedRawWebSocketUpgrade(user.id, () => {
        const upgraded = ctx.server?.upgrade(req, {
          data: {
            webappSocketHandler: "clanky",
            vncSessionId,
            vncMode: true,
            user,
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      });
    },
  },
  ...apiRoutes,
  ...meshInternalRoutes,
});

export const meshWorkerRoutes = defineRoutes<ClankyRealtimeEvent>({
  ...meshInternalRoutes,
  "/api/mesh/status": apiRoutes["/api/mesh/status"]!,
  "/api/mesh/instance-name": apiRoutes["/api/mesh/instance-name"]!,
  "/api/mesh/endpoint": apiRoutes["/api/mesh/endpoint"]!,
  "/api/mesh/execution": apiRoutes["/api/mesh/execution"]!,
  "/api/mesh/pairing-requests": apiRoutes["/api/mesh/pairing-requests"]!,
});

export function isMeshWorkerRequestAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") {
    return request.method === "GET";
  }
  if (path.startsWith("/api/mesh/internal/")) {
    const route = meshInternalRoutes[path];
    const method = ROUTE_METHODS.find((candidate) => candidate === request.method);
    return method !== undefined && Boolean(route?.[method]);
  }
  const methods = MESH_WORKER_CONTROL_ROUTE_METHODS[
    path as keyof typeof MESH_WORKER_CONTROL_ROUTE_METHODS
  ];
  return methods?.some((method) => method === request.method) ?? false;
}

export async function getWebAppServer(
  options: { meshWorker?: boolean } = {},
): Promise<WebAppServer<ClankyRealtimeEvent>> {
  const meshWorker = options.meshWorker ?? false;
  if (app) {
    if (appMeshWorkerMode !== meshWorker) {
      throw new Error(
        `Clanky server is already initialized with meshWorker=${String(appMeshWorkerMode)} and cannot be reused with meshWorker=${String(meshWorker)}`,
      );
    }
    return app;
  }
  await initializeDatabase();
  await ensureLocalMeshNodeIdentity();
  const dataDir = getDataDir();
  if (meshWorker && process.env["CLANKY_DISABLE_PASSKEY"] === "true") {
    throw new Error("Mesh-worker mode cannot be combined with CLANKY_DISABLE_PASSKEY");
  }
  const store = sqliteWebAppStore({ dataDir, fileName: "clanky.db" });
  app = createWebAppServer<ClankyRealtimeEvent>({
    appName: "Clanky",
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
    web: meshWorker ? false : {
      entry: "./frontend.tsx",
      icons: {
        favicon: { src: faviconPath, sizes: "any", type: "image/svg+xml" },
        appleTouch: { src: appleTouchIconPath, sizes: "180x180", type: "image/png" },
        manifest: [
          { src: manifestIcon192Path, sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: manifestIcon512Path, sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
    },
    ...(meshWorker ? { requestFilter: isMeshWorkerRequestAllowed } : {}),
    version: CLANKY_VERSION,
    store,
    auth: meshWorker
      ? { passkeys: false, apiKeys: true, deviceAuth: false }
      : { passkeys: true, apiKeys: true, deviceAuth: true },
    ...(meshWorker ? {} : { realtime: { path: "/api/ws" } }),
    routes: meshWorker ? meshWorkerRoutes : routes,
    websockets: {
      clanky: websocketHandlers as never,
    },
    lifecycle: {
      beforeStart: meshWorker
        ? initializeMeshWorkerRuntime
        : reconcileStartupState,
      afterStart: async (server) => await completeStartup(server, {
        startBackgroundWorkers: !meshWorker,
      }),
      beforeStop: async () => {
        realtimeHeartbeatCleanup?.();
        realtimeHeartbeatCleanup = undefined;
        stopBackgroundWorkers();
        await meshTerminalGateway.closeAll();
        await meshTcpTunnelGateway.closeAll();
        await closeAllMeshTerminalConnections();
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
  managedCredentialService.configure(app.store, {
    publicBaseUrl: app.config.publicBaseUrl,
    localBaseUrl: getLocalManagedCredentialBaseUrl(app.config.host, app.config.port),
  });
  if (!meshWorker) {
    registerClankyRealtimeBridge(app);
    realtimeHeartbeatCleanup = installRealtimeHeartbeat(app.realtime);
  }
  return app;
}

export function resetWebAppServerForTests(): void {
  stopBackgroundWorkers();
  realtimeHeartbeatCleanup?.();
  realtimeHeartbeatCleanup = undefined;
  unregisterClankyRealtimeBridge();
  managedCredentialService.resetForTests();
  app = undefined;
  appMeshWorkerMode = undefined;
}

export async function startServer(
  options: { meshWorker?: boolean } = {},
): Promise<Server<WebAppWebSocketData>> {
  return await (await getWebAppServer(options)).start();
}
