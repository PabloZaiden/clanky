/**
 * Main server startup for the Clanky web application.
 */

import type { Server } from "bun";
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import faviconPath from "./favicon.svg" with { type: "file" };
import manifestIcon192Path from "./web-app-manifest-192x192.png" with { type: "file" };
import manifestIcon512Path from "./web-app-manifest-512x512.png" with { type: "file" };
import { createWebAppServer, defineRoutes, getRequestOriginInfo, sqliteWebAppStore, type ResourceRealtimeEvent, type WebAppServer, type WebAppWebSocketData } from "@pablozaiden/webapp/server";
import { apiRoutes } from "./api";
import { websocketHandlers } from "./api/websocket";
import { ensureDataDirectories, getDataDir, initializeDatabase } from "./persistence/database";
import { resetStaleTasks } from "./persistence/tasks";
import { runForEachActiveUser } from "./core/background-users";
import { backendManager } from "./core/backend-manager";
import { getServerStartupMessages } from "./core/server-config";
import { log, setLogLevel } from "./core/logger";
import { pushedTaskMonitor } from "./core/pushed-task-monitor";
import { agentScheduler } from "./core/agent-scheduler";
import { getAppConfig } from "./core/config";
import {
  agentEventEmitter,
  chatEventEmitter,
  provisioningEventEmitter,
  sshSessionEventEmitter,
  taskEventEmitter,
  previewEventEmitter,
} from "./core/event-emitter";
import { getCurrentUserId } from "./core/user-context";
import { CLANKY_VERSION } from "./version";

type ClankyRealtimeEvent = ResourceRealtimeEvent | Record<string, unknown>;
const PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS = 0;

let app: WebAppServer<ClankyRealtimeEvent> | undefined;
let realtimeBridgeRegistered = false;

function publishClankyRealtimeEvent(
  appServer: WebAppServer<ClankyRealtimeEvent>,
  event: object,
  target: Record<string, string | undefined>,
): void {
  const userId = getCurrentUserId();
  if (!userId) {
    log.warn("Skipping user realtime event without an active user context", {
      eventType: typeof event === "object" && event !== null && "type" in event ? String(event.type) : "unknown",
    });
    return;
  }
  appServer.realtime.publish(event as ClankyRealtimeEvent, {
    target: {
      ...target,
      userId,
    },
  });
}

function registerClankyRealtimeBridge(appServer: WebAppServer<ClankyRealtimeEvent>): void {
  if (realtimeBridgeRegistered) {
    return;
  }
  realtimeBridgeRegistered = true;
  taskEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { taskId: event.taskId }));
  chatEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { chatId: event.chatId }));
  agentEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { agentId: event.agentId }));
  sshSessionEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { sshSessionId: event.sshSessionId }));
  provisioningEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { provisioningJobId: event.provisioningJobId }));
  previewEventEmitter.subscribe((event) => publishClankyRealtimeEvent(appServer, event, { workspaceId: event.workspaceId }));
}

export const routes = defineRoutes<ClankyRealtimeEvent>({
  "/api/previews/bridge": {
    auth: "user",
    sameOrigin: "always",
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
  await ensureDataDirectories();
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
    logLevel: { onChange: setLogLevel },
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
  registerClankyRealtimeBridge(app);
  return app;
}

export function resetWebAppServerForTests(): void {
  app = undefined;
}

export async function startServer(): Promise<Server<WebAppWebSocketData>> {
  const appServer = await getWebAppServer();

  await backendManager.initialize();

  let staleTasksReset = 0;
  await runForEachActiveUser(async () => {
    staleTasksReset += await resetStaleTasks();
  });
  if (staleTasksReset > 0) {
    log.info(`Reconciled ${staleTasksReset} stale tasks during startup`);
  }

  const server = await appServer.start();
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
