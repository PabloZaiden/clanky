/**
 * Shared Mesh relay wire policy.
 *
 * The relay broker enforces these tables on the server side and every relay
 * peer enforces the same tables locally, so a compromised or buggy relay
 * cannot widen the Mesh surface that a node is willing to serve.
 */

import type { MeshRelayPeerRole, MeshRelayStreamKind } from "@/shared/mesh-relay";

export const MESH_RELAY_MAX_CONTROL_FRAME_BYTES = 256 * 1_024;
export const MESH_RELAY_MAX_STREAM_FRAME_BYTES = 2 * 1_024 * 1_024;
export const MESH_RELAY_MAX_QUEUED_BYTES = 4 * 1_024 * 1_024;
export const MESH_RELAY_MAX_HEADER_BYTES = 64 * 1_024;
export const MESH_RELAY_MAX_HEADER_COUNT = 64;
export const MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES = 512 * 1_024;

export const MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR = 4_400;
export const MESH_RELAY_STREAM_CLOSE_CANCELLED = 4_408;
export const MESH_RELAY_STREAM_CLOSE_TIMEOUT = 4_410;
export const MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED = 4_500;
export const MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED = 4_501;

/** Hop-by-hop and connection headers that must never cross the relay. */
export const MESH_RELAY_PROHIBITED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** HTTP routes a controller may open towards a worker. */
export const MESH_RELAY_CONTROLLER_HTTP_ROUTES: ReadonlyMap<string, ReadonlySet<string>> =
  new Map<string, ReadonlySet<string>>([
    ["/api/mesh/internal/revocation", new Set(["POST"])],
    ["/api/mesh/internal/kill", new Set(["POST"])],
    ["/api/mesh/internal/health", new Set(["POST"])],
    ["/api/mesh/internal/execution/session", new Set(["POST", "DELETE"])],
    ["/api/mesh/internal/execution/rpc", new Set(["POST"])],
    ["/api/mesh/internal/execution/async", new Set(["POST"])],
    ["/api/mesh/internal/execution/file", new Set(["GET", "POST"])],
    ["/api/mesh/internal/execution/acp/renew", new Set(["POST"])],
    ["/api/mesh/internal/terminal/session", new Set(["POST", "DELETE"])],
    ["/api/mesh/internal/tcp-tunnel/session", new Set(["POST"])],
  ]);

/** Socket routes a controller may open towards a worker. */
export const MESH_RELAY_CONTROLLER_SOCKET_ROUTES: ReadonlySet<string> = new Set([
  "/api/mesh/internal/execution/acp",
  "/api/mesh/internal/terminal",
  "/api/mesh/internal/tcp-tunnel",
]);

/** HTTP routes a worker may open towards its controller. */
export const MESH_RELAY_WORKER_HTTP_ROUTES: ReadonlyMap<string, ReadonlySet<string>> =
  new Map<string, ReadonlySet<string>>([
    ["/api/mesh/internal/enrollment", new Set(["POST"])],
  ]);

/** The only Mesh route that accepts a relay query string. */
export const MESH_RELAY_QUERY_ROUTE = "/api/mesh/internal/execution/file";

/**
 * Decide whether an initiator with `initiatorRole` may open `kind` streams
 * for `pathname`. `method` is required for HTTP streams and forbidden for
 * socket streams.
 */
export function isMeshRelayRouteAllowed(
  initiatorRole: MeshRelayPeerRole,
  kind: MeshRelayStreamKind,
  method: string | undefined,
  pathname: string,
): boolean {
  if (kind === "socket") {
    return method === undefined
      && initiatorRole === "controller"
      && MESH_RELAY_CONTROLLER_SOCKET_ROUTES.has(pathname);
  }
  if (!method) {
    return false;
  }
  const routes = initiatorRole === "controller"
    ? MESH_RELAY_CONTROLLER_HTTP_ROUTES
    : MESH_RELAY_WORKER_HTTP_ROUTES;
  return routes.get(pathname)?.has(method.toUpperCase()) ?? false;
}

/** The role that initiates streams served by a node running `localRole`. */
export function meshRelayInitiatorRole(
  localRole: MeshRelayPeerRole,
): MeshRelayPeerRole {
  return localRole === "worker" ? "controller" : "worker";
}
