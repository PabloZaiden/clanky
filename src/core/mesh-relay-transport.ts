/**
 * `MeshPeerTransport` implementation backed by a relay control connection.
 */

import type { MeshPeerRoute, MeshRelayPeerRoute } from "@/shared/mesh";
import { DomainError } from "./domain-error";
import type {
  MeshDuplexSocket,
  MeshPeerRequest,
  MeshPeerTransport,
} from "./mesh-peer-transport";
import type { MeshRelayConnector } from "./mesh-relay-connector";
import {
  performMeshRelayHttpRequest,
  sanitizeMeshRelayRequestHeaders,
} from "./mesh-relay-http";
import { MeshRelayDuplexSocket } from "./mesh-relay-socket";

export type MeshRelayConnectorResolver = (
  route: MeshRelayPeerRoute,
) => MeshRelayConnector;

function requireRelayRoute(route: MeshPeerRoute): MeshRelayPeerRoute {
  if (route.kind !== "relay") {
    throw new DomainError(
      "mesh_transport_route_invalid",
      "The relay Mesh transport requires a relay route.",
    );
  }
  return route;
}

/**
 * Create the transport installed through `setMeshRelayTransport`.
 *
 * `resolve` selects the connector that owns the route; it throws when no
 * matching relay connection is currently established.
 */
export function createMeshRelayPeerTransport(
  resolve: MeshRelayConnectorResolver,
): MeshPeerTransport {
  return {
    async request(
      route: MeshPeerRoute,
      path: string,
      request: MeshPeerRequest,
    ): Promise<Response> {
      const relayRoute = requireRelayRoute(route);
      const connector = resolve(relayRoute);
      const stream = await connector.openStream({
        kind: "http",
        method: (request.method ?? "GET").toUpperCase(),
        path,
        headers: sanitizeMeshRelayRequestHeaders(request.headers),
        targetNodeId: relayRoute.targetNodeId,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return await performMeshRelayHttpRequest(stream, {
        body: request.body ?? null,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },

    openSocket(
      route: MeshPeerRoute,
      path: string,
      headers: Record<string, string>,
    ): MeshDuplexSocket {
      return new MeshRelayDuplexSocket(async (signal) => {
        const relayRoute = requireRelayRoute(route);
        const connector = resolve(relayRoute);
        return await connector.openStream({
          kind: "socket",
          path,
          headers: sanitizeMeshRelayRequestHeaders(headers),
          targetNodeId: relayRoute.targetNodeId,
          signal,
        });
      });
    },
  };
}
