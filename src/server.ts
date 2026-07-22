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
import { websocketHandlers } from "./api/websocket";
import { getDataDir, initializeDatabase } from "./persistence/database";
import { resetStaleTasks } from "./persistence/tasks";
import { runForEachActiveUser } from "./core/background-users";
import { backendManager } from "./core/backend-manager";
import { isServerEvent, type ServerEvent } from "./core/backend/backend-state";
import { getServerStartupMessages } from "./core/server-config";
import { pushedTaskMonitor } from "./core/pushed-task-monitor";
import { agentScheduler } from "./core/agent-scheduler";
import { getAppConfig } from "./core/config";
import { managedCredentialService } from "./core/managed-credential-service";
import {
  agentEventEmitter,
  chatEventEmitter,
  provisioningEventEmitter,
  sshSessionEventEmitter,
  taskEventEmitter,
  previewEventEmitter,
} from "./core/event-emitter";
import type { EventContext } from "./core/event-emitter";
import {
  createClankyRealtimePublisher,
  publishClankyDomainEvent,
  type ClankyDomainEvent,
  type ClankyRealtimeEvent,
} from "./realtime";
import { CLANKY_VERSION } from "./version";

const PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS = 0;

let app: WebAppServer<ClankyRealtimeEvent> | undefined;
let realtimeBridgeUnsubscribers: Array<() => void> | undefined;

function normalizeLocalManagedCredentialHost(host: string): string | undefined {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (normalizedHost === "127.0.0.1" || normalizedHost === "localhost") {
    return normalizedHost;
  }
  if (normalizedHost === "::1" || normalizedHost === "[::1]") {
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
    sshSessionEventEmitter.subscribe(publishEvent),
    provisioningEventEmitter.subscribe(publishEvent),
    previewEventEmitter.subscribe(publishEvent),
  ];
}

function unregisterClankyRealtimeBridge(): void {
  for (const unsubscribe of realtimeBridgeUnsubscribers ?? []) {
    unsubscribe();
  }
  realtimeBridgeUnsubscribers = undefined;
}

export const routes = defineRoutes<ClankyRealtimeEvent>({
  "/api/previews/bridge": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for a workspace preview.",
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      ctx.server?.timeout(req, PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS);
      const upgraded = ctx.server?.upgrade(req, {
        data: {
          webappSocketHandler: "clanky",
          previewBridgeMode: true,
          user,
        },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
  },
  "/api/ssh-terminal": {
    auth: "user",
    sameOrigin: "always",
    description: "Open the raw websocket bridge for an SSH terminal.",
    GET: (req, ctx) => {
      const user = ctx.requireUser();
      const url = new URL(req.url);
      const sshSessionId = url.searchParams.get("sshSessionId") ?? undefined;
      const sshServerSessionId = url.searchParams.get("sshServerSessionId") ?? undefined;

      if (!sshSessionId && !sshServerSessionId) {
        return new Response("sshSessionId or sshServerSessionId is required", { status: 400 });
      }

      const upgraded = ctx.server?.upgrade(req, {
        data: {
          webappSocketHandler: "clanky",
          sshSessionId,
          sshServerSessionId,
          terminalMode: true,
          user,
        },
      });

      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
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
      const upgraded = ctx.server?.upgrade(req, {
        data: {
          webappSocketHandler: "clanky",
          vncSessionId,
          vncMode: true,
          user,
        },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },
  },
  ...apiRoutes,
});

export async function getWebAppServer(): Promise<WebAppServer<ClankyRealtimeEvent>> {
  if (app) return app;
  await initializeDatabase();
  const dataDir = getDataDir();
  const store = sqliteWebAppStore({ dataDir, fileName: "clanky.db" });
  app = createWebAppServer<ClankyRealtimeEvent>({
    appName: "Clanky",
    envPrefix: "CLANKY",
    web: {
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
    version: CLANKY_VERSION,
    store,
    auth: { passkeys: true, apiKeys: true, deviceAuth: true },
    realtime: { path: "/api/ws" },
    routes,
    websockets: {
      clanky: websocketHandlers as never,
    },
    configResponse: (req) => {
      const publicBasePath = app ? getRequestOriginInfo(req, app.config).pathPrefix : "/";
      return {
        ...getAppConfig(),
        publicBasePath: publicBasePath === "/" ? null : publicBasePath,
      };
    },
  });
  managedCredentialService.configure(app.store, {
    publicBaseUrl: app.config.publicBaseUrl
      ?? getLocalManagedCredentialBaseUrl(app.config.host, app.config.port),
  });
  registerClankyRealtimeBridge(app);
  return app;
}

export function resetWebAppServerForTests(): void {
  unregisterClankyRealtimeBridge();
  managedCredentialService.resetForTests();
  app = undefined;
}

export async function startServer(): Promise<Server<WebAppWebSocketData>> {
  const appServer = await getWebAppServer();

  await backendManager.initialize();

  let staleTasksReset = 0;
  let staleManagedContextsRevoked = 0;
  await runForEachActiveUser(async () => {
    staleTasksReset += await resetStaleTasks();
    staleManagedContextsRevoked += await managedCredentialService.reconcileCurrentUser();
  });
  if (staleTasksReset > 0) {
    log.info(`Reconciled ${staleTasksReset} stale tasks during startup`);
  }
  if (staleManagedContextsRevoked > 0) {
    log.info(`Revoked ${staleManagedContextsRevoked} stale managed execution contexts during startup`);
  }

  const server = await appServer.start();
  const serverUrl = new URL(server.url);
  const localManagedCredentialBaseUrl = getLocalManagedCredentialBaseUrl(
    serverUrl.hostname,
    Number(serverUrl.port),
  );
  if (!appServer.config.publicBaseUrl && localManagedCredentialBaseUrl) {
    managedCredentialService.configure(appServer.store, {
      publicBaseUrl: localManagedCredentialBaseUrl,
    });
  }
  pushedTaskMonitor.start();
  agentScheduler.start();

  for (const message of getServerStartupMessages({
    host: appServer.config.host,
    port: appServer.config.port,
    hostSource: process.env["CLANKY_HOST"]?.trim() ? "CLANKY_HOST" : "default",
    sameOriginProtection: { disabled: appServer.config.sameOriginDisabled },
  })) {
    log.info(message);
  }
  log.info(`Clanky server running at ${server.url}`);
  return server;
}
