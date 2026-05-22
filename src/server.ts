/**
 * Main server startup for the Clanky web application.
 */

import { serve, type Server } from "bun";
import index from "./index.html";
import { posix as pathPosix } from "path";
import { apiRoutes } from "./api";
import {
  wrapRouteHandlerWithApplicationAuth,
  wrapRoutesWithApplicationAuth,
} from "./api/application-auth";
import { wrapRoutesWithLogging, wrapRouteHandlerWithLogging } from "./api/request-logging";
import {
  wrapRouteHandlerWithSameOriginProtection,
  wrapRoutesWithSameOriginProtection,
} from "./api/same-origin-guard";
import { portForwardProxyRoutes } from "./api/port-forwards";
import { ensureDataDirectories } from "./persistence/database";
import { resetStaleTasks } from "./persistence/tasks";
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
import { pushedTaskMonitor } from "./core/pushed-task-monitor";
import { parseSensitiveFlag } from "./lib/sensitive-data";

type StoppableServer = {
  stop(closeActiveConnections?: boolean): void;
};

function getConfiguredWebDistDir(): string | undefined {
  const configuredDir = process.env["CLANKY_WEB_DIST_DIR"]?.trim();
  return configuredDir ? configuredDir.replace(/\/+$/, "") : undefined;
}

function getWebAssetPath(distDir: string, pathname: string): string {
  const normalizedPath = pathPosix.normalize(pathname === "/" ? "/index.html" : pathname);
  const segments = normalizedPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  return `${distDir}/${segments.join("/")}`;
}

function decodeWebPathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

export async function serveWebApp(req: Request) {
  const distDir = getConfiguredWebDistDir();
  if (!distDir) {
    return new Response("CLANKY_WEB_DIST_DIR is not configured.", { status: 500 });
  }

  const url = new URL(req.url);
  const decodedPathname = decodeWebPathname(url.pathname);
  if (decodedPathname === undefined) {
    return new Response("Malformed request path", { status: 400 });
  }

  const assetPath = getWebAssetPath(distDir, decodedPathname);
  const assetFile = Bun.file(assetPath);
  if (await assetFile.exists()) {
    return new Response(assetFile);
  }

  const spaIndex = Bun.file(`${distDir}/index.html`);
  if (await spaIndex.exists()) {
    return new Response(spaIndex);
  }

  return new Response("Configured web dist is missing index.html.", { status: 500 });
}

export function getWebAppRoute() {
  return getConfiguredWebDistDir() ? serveWebApp : index;
}

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

export async function startServer(): Promise<void> {
  await ensureDataDirectories();

  if (!isLogLevelFromEnv()) {
    const savedLogLevel = await getLogLevelPreference();
    setLogLevel(savedLogLevel);
    log.debug(`Log level set from saved preference: ${savedLogLevel}`);
  } else {
    log.debug("Log level set from CLANKY_LOG_LEVEL environment variable");
  }

  await backendManager.initialize();

  const staleTasksReset = await resetStaleTasks();
  if (staleTasksReset > 0) {
    log.info(`Reconciled ${staleTasksReset} stale tasks during startup`);
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
        const taskId = url.searchParams.get("taskId") ?? undefined;
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const sshSessionId = url.searchParams.get("sshSessionId") ?? undefined;
        const sshServerSessionId = url.searchParams.get("sshServerSessionId") ?? undefined;
        const provisioningJobId = url.searchParams.get("provisioningJobId") ?? undefined;
        const sensitive = parseSensitiveFlag(url.searchParams.get("sensitive"));

        const upgraded = server.upgrade(req, {
          data: {
            taskId,
            chatId,
            sshSessionId,
            sshServerSessionId,
            provisioningJobId,
            sensitive,
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
      "/*": getWebAppRoute(),
    },
    websocket: websocketHandlers,
    development,
  });

  pushedTaskMonitor.start();

  registerServerShutdown([server, pushedTaskMonitor]);

  for (const message of getServerStartupMessages(runtimeConfig)) {
    log.info(message);
  }
  log.info(`Clanky server running at ${server.url}`);
}
