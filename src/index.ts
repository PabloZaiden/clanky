/**
 * Main server entry point for Ralph Loops Management System.
 * Uses Bun's native serve() with route-based API and WebSocket support.
 */

import { serve, type Server } from "bun";
import index from "./index.html";
import { apiRoutes } from "./api";
import {
  wrapRouteHandlerWithApplicationAuth,
  wrapRoutesWithApplicationAuth,
} from "./api/application-auth";
import { wrapRoutesWithLogging, wrapRouteHandlerWithLogging } from "./api/request-logging";
import { wrapRouteHandlerWithSameOriginProtection, wrapRoutesWithSameOriginProtection } from "./api/same-origin-guard";
import { portForwardProxyRoutes } from "./api/port-forwards";
import { ensureDataDirectories } from "./persistence/database";
import { resetStaleLoops } from "./persistence/loops";
import { backendManager } from "./core/backend-manager";
import { websocketHandlers, type WebSocketData } from "./api/websocket";
import {
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  getServerDevelopmentConfig,
  getServerRuntimeConfig,
  getServerStartupMessages,
} from "./core/server-config";
import { log, setLogLevel, isLogLevelFromEnv } from "./core/logger";
import { getLogLevelPreference } from "./persistence/preferences";
import { pushedLoopMonitor } from "./core/pushed-loop-monitor";

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

try {
  // Ensure data directories exist on startup
  await ensureDataDirectories();

  // Initialize log level from saved preference (unless environment variable is set)
  if (!isLogLevelFromEnv()) {
    const savedLogLevel = await getLogLevelPreference();
    setLogLevel(savedLogLevel);
    log.debug(`Log level set from saved preference: ${savedLogLevel}`);
  } else {
    log.debug(`Log level set from RALPHER_LOG_LEVEL environment variable`);
  }

  // Initialize the global backend manager (loads settings from preferences)
  await backendManager.initialize();

  const staleLoopsReset = await resetStaleLoops();
  if (staleLoopsReset > 0) {
    log.info(`Reconciled ${staleLoopsReset} stale loops during startup`);
  }

  const runtimeConfig = getServerRuntimeConfig();
  const development = getServerDevelopmentConfig();
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
  const sameOriginProtectionOptions = {
    disabled: runtimeConfig.sameOriginProtection.disabled,
  };
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
    // Increase idle timeout from default 10s for long-running operations
    // like git push/pull/fetch that happen over the network
    idleTimeout: DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
    routes: {
      // API routes
      ...loggedApiRoutes,
      ...sameOriginProtectedPortForwardRoutes,

      // WebSocket endpoint for real-time events
      "/api/ws": websocketRoute,

      "/api/ssh-terminal": sshTerminalRoute,

      // Serve index.html for all unmatched routes (SPA fallback)
      "/*": index,
    },

    // WebSocket handlers
    websocket: websocketHandlers,

    development,
  });

  pushedLoopMonitor.start();

  registerServerShutdown([server, pushedLoopMonitor]);

  for (const message of getServerStartupMessages(runtimeConfig)) {
    log.info(message);
  }
  log.info(`Ralpher server running at ${server.url}`);
} catch (error) {
  // Use console.error as a last resort since the logger may not be initialized
  console.error(`Fatal error during startup: ${String(error)}`);
  process.exit(1);
}
