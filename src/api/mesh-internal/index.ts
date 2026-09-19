/**
 * Signed Mesh internal routes grouped by protocol capability.
 *
 * These routes are public at the framework boundary because a peer node has
 * no local user session. Each capability delegates signed authorization and
 * resource ownership to its Mesh manager or gateway.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { meshAcpRoutes } from "./acp";
import { meshControlRoutes } from "./control";
import { meshExecutionRoutes } from "./execution";
import { meshTerminalRoutes } from "./terminal";
import { meshTunnelRoutes } from "./tunnel";

export const meshInternalRoutes = defineRoutes({
  ...meshControlRoutes,
  ...meshExecutionRoutes,
  ...meshAcpRoutes,
  ...meshTerminalRoutes,
  ...meshTunnelRoutes,
});

export const meshControllerInternalRoutes = defineRoutes({
  "/api/mesh/internal/enrollment": meshInternalRoutes["/api/mesh/internal/enrollment"]!,
});

export const meshWorkerInternalRoutes = defineRoutes({
  "/api/mesh/internal/revocation": meshInternalRoutes["/api/mesh/internal/revocation"]!,
  "/api/mesh/internal/kill": meshInternalRoutes["/api/mesh/internal/kill"]!,
  "/api/mesh/internal/health": meshInternalRoutes["/api/mesh/internal/health"]!,
  "/api/mesh/internal/execution/session": meshInternalRoutes["/api/mesh/internal/execution/session"]!,
  "/api/mesh/internal/execution/rpc": meshInternalRoutes["/api/mesh/internal/execution/rpc"]!,
  "/api/mesh/internal/execution/async": meshInternalRoutes["/api/mesh/internal/execution/async"]!,
  "/api/mesh/internal/execution/file": meshInternalRoutes["/api/mesh/internal/execution/file"]!,
  "/api/mesh/internal/execution/acp": meshInternalRoutes["/api/mesh/internal/execution/acp"]!,
  "/api/mesh/internal/execution/acp/renew": meshInternalRoutes["/api/mesh/internal/execution/acp/renew"]!,
  "/api/mesh/internal/terminal/session": meshInternalRoutes["/api/mesh/internal/terminal/session"]!,
  "/api/mesh/internal/terminal": meshInternalRoutes["/api/mesh/internal/terminal"]!,
  "/api/mesh/internal/tcp-tunnel/session": meshInternalRoutes["/api/mesh/internal/tcp-tunnel/session"]!,
  "/api/mesh/internal/tcp-tunnel": meshInternalRoutes["/api/mesh/internal/tcp-tunnel"]!,
});

