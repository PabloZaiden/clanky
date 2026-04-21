import { serve, type Server } from "bun";

import index from "../../../src/index.html";
import { apiRoutes } from "../../../src/api";
import { wrapRouteHandlerWithApplicationAuth, wrapRoutesWithApplicationAuth } from "../../../src/api/application-auth";
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

await ensureDataDirectories();
await backendManager.initialize();
await resetStaleLoops();

const runtimeConfig = getServerRuntimeConfig();
const development = getServerDevelopmentConfig();
const sameOriginProtectionOptions = {
  disabled: runtimeConfig.sameOriginProtection.disabled,
};
const publicAuthRoutes = new Set([
  "/api/config",
  "/api/passkey-auth/status",
  "/api/passkey-auth/authentication/options",
  "/api/passkey-auth/authentication/verify",
  "/api/passkey-auth/logout",
  "/api/auth/device",
  "/api/auth/token",
  "/api/auth/refresh",
  "/api/auth/revoke",
  "/.well-known/jwks.json",
  "/.well-known/openid-configuration",
]);
const protectedApiRoutes = wrapRoutesWithApplicationAuth(apiRoutes, publicAuthRoutes);
const loggedApiRoutes = wrapRoutesWithLogging(
  wrapRoutesWithSameOriginProtection(protectedApiRoutes, sameOriginProtectionOptions),
);
const protectedPortForwardRoutes = wrapRoutesWithApplicationAuth(portForwardProxyRoutes);
const sameOriginProtectedPortForwardRoutes = wrapRoutesWithSameOriginProtection(
  protectedPortForwardRoutes,
  sameOriginProtectionOptions,
);

const websocketRoute = wrapRouteHandlerWithLogging(
  wrapRouteHandlerWithSameOriginProtection(
    wrapRouteHandlerWithApplicationAuth((req: Request, server: Server<WebSocketData>) => {
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
    }),
    {
      ...sameOriginProtectionOptions,
      alwaysProtect: true,
    },
  ),
  "/api/ws",
);

const sshTerminalRoute = wrapRouteHandlerWithLogging(
  wrapRouteHandlerWithSameOriginProtection(
    wrapRouteHandlerWithApplicationAuth((req: Request, server: Server<WebSocketData>) => {
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
    }),
    {
      ...sameOriginProtectionOptions,
      alwaysProtect: true,
    },
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
    "/*": index,
  },
  websocket: websocketHandlers,
  development,
});

registerServerShutdown([server]);
