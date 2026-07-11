/**
 * Main server startup for the Clanky web application.
 */

import type { Server } from "bun";
import appleTouchIconPath from "./apple-touch-icon.png" with { type: "file" };
import faviconPath from "./favicon.svg" with { type: "file" };
import manifestIcon192Path from "./web-app-manifest-192x192.png" with { type: "file" };
import manifestIcon512Path from "./web-app-manifest-512x512.png" with { type: "file" };
import { createWebAppServer, defineRoutes, sqliteWebAppStore, type ResourceRealtimeEvent, type RouteDefinition, type RouteTable, type WebAppServer, type WebAppWebSocketData } from "@pablozaiden/webapp/server";
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
import { getPublicBasePathFromForwardedPrefix } from "./utils/public-base-path";
import { runWithCurrentUser } from "./core/user-context";
import { CLANKY_VERSION } from "./version";

type ClankyRealtimeEvent = ResourceRealtimeEvent | Record<string, unknown>;
type LegacyRouteHandler = (req: Request, server?: Server<WebAppWebSocketData>) => Response | undefined | Promise<Response | undefined>;
type LegacyRouteMethods = Record<string, LegacyRouteHandler>;
type LegacyRouteValue = LegacyRouteMethods | LegacyRouteHandler;

const PREVIEW_BRIDGE_IDLE_TIMEOUT_SECONDS = 0;
const PURGE_REQUEST_IDLE_TIMEOUT_SECONDS = 0;
const PURGE_ROUTES_WITHOUT_IDLE_TIMEOUT = new Set([
  "/api/settings/purge-terminal-tasks",
  "/api/workspaces/:id/archived-tasks/purge",
]);

let app: WebAppServer<ClankyRealtimeEvent> | undefined;
let realtimeBridgeRegistered = false;

function legacyRequest(req: Request, params: Record<string, string>): Request {
  const wrapped = new Request(req);
  Object.defineProperty(wrapped, "params", {
    value: params,
    enumerable: true,
  });
  return wrapped;
}

export function configureLegacyRouteRequestTimeout(
  path: string,
  req: Request,
  server?: Pick<Server<WebAppWebSocketData>, "timeout">,
): void {
  if (PURGE_ROUTES_WITHOUT_IDLE_TIMEOUT.has(path)) {
    server?.timeout(req, PURGE_REQUEST_IDLE_TIMEOUT_SECONDS);
  }
}

function adaptHandler(
  path: string,
  handler: (req: Request, server?: Server<WebAppWebSocketData>) => Response | undefined | Promise<Response | undefined>,
) {
  return async (req: Request, ctx: Parameters<NonNullable<RouteDefinition<ClankyRealtimeEvent>["GET"]>>[1]) => {
    const user = ctx.requireUser();
    configureLegacyRouteRequestTimeout(path, req, ctx.server);
    return await runWithCurrentUser(user, () => handler(legacyRequest(req, ctx.params), ctx.server as Server<WebAppWebSocketData> | undefined));
  };
}

function adaptLegacyRoutes(routes: Record<string, LegacyRouteValue>): RouteTable<ClankyRealtimeEvent> {
  const converted: RouteTable<ClankyRealtimeEvent> = {};
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  for (const [path, route] of Object.entries(routes)) {
    const auth = path === "/api/settings/reset-all" || path === "/api/settings/purge-terminal-tasks" ? "owner" : "user";
    if (typeof route === "function") {
      converted[path] = {
        auth,
        sameOrigin: path.startsWith("/task/") ? "always" : "mutations",
        ...Object.fromEntries(methods.map((method) => [method, adaptHandler(path, route as LegacyRouteHandler)])),
      };
      continue;
    }

    converted[path] = {
      auth,
      sameOrigin: path.startsWith("/task/") ? "always" : "mutations",
    };
    for (const method of methods) {
      const handler = route[method];
      if (handler) {
        converted[path]![method] = adaptHandler(path, handler);
      }
    }
  }
  return converted;
}

function publishLegacyEvent(
  appServer: WebAppServer<ClankyRealtimeEvent>,
  event: object,
  target: Record<string, string | undefined>,
): void {
  appServer.realtime.publish(event as ClankyRealtimeEvent, { target });
}

function registerRealtimeBridge(appServer: WebAppServer<ClankyRealtimeEvent>): void {
  if (realtimeBridgeRegistered) {
    return;
  }
  realtimeBridgeRegistered = true;
  taskEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { taskId: event.taskId }));
  chatEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { chatId: event.chatId }));
  agentEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { agentId: event.agentId }));
  sshSessionEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { sshSessionId: event.sshSessionId }));
  provisioningEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { provisioningJobId: event.provisioningJobId }));
  previewEventEmitter.subscribe((event) => publishLegacyEvent(appServer, event, { workspaceId: event.workspaceId }));
}

const routes = defineRoutes<ClankyRealtimeEvent>({
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
  ...adaptLegacyRoutes(apiRoutes as unknown as Record<string, LegacyRouteValue>),
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
      const publicBasePath = getPublicBasePathFromForwardedPrefix(req.headers.get("x-forwarded-prefix"));
      return {
        ...getAppConfig(),
        publicBasePath: publicBasePath || null,
      };
    },
  });
  registerRealtimeBridge(app);
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
