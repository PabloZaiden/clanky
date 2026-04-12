import { serve, type Server } from "bun";

import index from "../../../src/index.html";
import { apiRoutes } from "../../../src/api";
import {
  createAuthenticatedStaticRoute,
  createStaticAssetServer,
  wrapRouteHandler,
  wrapRoutesWithBasicAuth,
} from "../../../src/api/basic-auth";
import { portForwardProxyRoutes } from "../../../src/api/port-forwards";
import { wrapRouteHandlerWithLogging, wrapRoutesWithLogging } from "../../../src/api/request-logging";
import { wrapRouteHandlerWithSameOriginProtection, wrapRoutesWithSameOriginProtection } from "../../../src/api/same-origin-guard";
import { websocketHandlers, type WebSocketData } from "../../../src/api/websocket";
import { backendManager } from "../../../src/core/backend-manager";
import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  getServerDevelopmentConfig,
  getServerRuntimeConfig,
} from "../../../src/core/server-config";
import { sshServerManager } from "../../../src/core/ssh-server-manager";
import { ensureDataDirectories } from "../../../src/persistence/database";
import { resetStaleLoops } from "../../../src/persistence/loops";
import { TestCommandExecutor } from "../../mocks/mock-executor";

type StoppableServer = {
  stop(closeActiveConnections?: boolean): void;
};

function registerServerShutdown(servers: StoppableServer[]): void {
  let alreadyStopped = false;

  const stopServers = () => {
    if (alreadyStopped) {
      return;
    }

    alreadyStopped = true;
    for (const server of servers) {
      server.stop(true);
    }
  };

  process.once("SIGINT", stopServers);
  process.once("SIGTERM", stopServers);
}

backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

let staticAssetServer: Server<undefined> | undefined;

await ensureDataDirectories();
await backendManager.initialize();
await resetStaleLoops();

const runtimeConfig = getServerRuntimeConfig();
const development = getServerDevelopmentConfig();
staticAssetServer = runtimeConfig.basicAuth.enabled
  ? createStaticAssetServer(index, development)
  : undefined;

const staticRoute = staticAssetServer
  ? createAuthenticatedStaticRoute(staticAssetServer, runtimeConfig.basicAuth)
  : index;
const protectedApiRoutes = wrapRoutesWithBasicAuth(apiRoutes, runtimeConfig.basicAuth);
const loggedApiRoutes = wrapRoutesWithLogging(wrapRoutesWithSameOriginProtection(protectedApiRoutes));
const protectedPortForwardRoutes = wrapRoutesWithBasicAuth(
  portForwardProxyRoutes,
  runtimeConfig.basicAuth,
);
const sameOriginProtectedPortForwardRoutes = wrapRoutesWithSameOriginProtection(protectedPortForwardRoutes);

const websocketRoute = wrapRouteHandlerWithLogging(
  wrapRouteHandlerWithSameOriginProtection(
    wrapRouteHandler(
      (req: Request, server: Server<WebSocketData>) => {
        const url = new URL(req.url);
        const loopId = url.searchParams.get("loopId") ?? undefined;
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const sshSessionId = url.searchParams.get("sshSessionId") ?? undefined;
        const sshServerSessionId = url.searchParams.get("sshServerSessionId") ?? undefined;
        const provisioningJobId = url.searchParams.get("provisioningJobId") ?? undefined;

        const upgraded = server.upgrade(req, {
          data: {
            loopId,
            chatId,
            sshSessionId,
            sshServerSessionId,
            provisioningJobId,
            terminalMode: false,
          } as WebSocketData,
        });

        if (upgraded) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 400 });
      },
      runtimeConfig.basicAuth,
    ),
    { alwaysProtect: true },
  ),
  "/api/ws",
);

const sshTerminalRoute = wrapRouteHandlerWithLogging(
  wrapRouteHandlerWithSameOriginProtection(
    wrapRouteHandler(
      (req: Request, server: Server<WebSocketData>) => {
        const url = new URL(req.url);
        const sshSessionId = url.searchParams.get("sshSessionId") ?? undefined;
        const sshServerSessionId = url.searchParams.get("sshServerSessionId") ?? undefined;

        if (!sshSessionId && !sshServerSessionId) {
          return new Response("sshSessionId or sshServerSessionId is required", { status: 400 });
        }

        const upgraded = server.upgrade(req, {
          data: { sshSessionId, sshServerSessionId, terminalMode: true } as WebSocketData,
        });

        if (upgraded) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 400 });
      },
      runtimeConfig.basicAuth,
    ),
    { alwaysProtect: true },
  ),
  "/api/ssh-terminal",
);

const server = serve<WebSocketData>({
  hostname: runtimeConfig.host,
  port: runtimeConfig.port,
  idleTimeout: DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  routes: {
    ...loggedApiRoutes,
    ...sameOriginProtectedPortForwardRoutes,
    "/api/ws": websocketRoute,
    "/api/ssh-terminal": sshTerminalRoute,
    "/*": staticRoute,
  },
  websocket: websocketHandlers,
  development,
});

registerServerShutdown(staticAssetServer ? [server, staticAssetServer] : [server]);
