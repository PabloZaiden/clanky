/**
 * `MeshPeerTransport` implementation backed by a relay control connection.
 */

import { isMeshOutboundRoute, type MeshPeerRoute, type MeshRelayPeerRoute } from "@/shared/mesh";
import { DomainError } from "../domain/domain-error";
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
import {
  MESH_RELAY_RESPONSE_FLOW_HEADER,
  MESH_RELAY_RESPONSE_FLOW_VERSION,
} from "./mesh-relay-http-response-flow";

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
  return createMeshStreamPeerTransport((route) => resolve(requireRelayRoute(route)));
}

export function createMeshStreamPeerTransport(
  resolve: (route: MeshPeerRoute) => MeshRelayConnector,
): MeshPeerTransport {
  const targetNodeId = (route: MeshPeerRoute): string => {
    if (route.kind === "relay" || isMeshOutboundRoute(route)) return route.targetNodeId;
    throw new DomainError("mesh_transport_route_invalid", "Mesh streams require an outbound peer route.");
  };
  return {
    async request(
      route: MeshPeerRoute,
      path: string,
      request: MeshPeerRequest,
    ): Promise<Response> {
      const target = targetNodeId(route);
      const connector = resolve(route);
      const headers = new Headers(request.headers);
      headers.set(MESH_RELAY_RESPONSE_FLOW_HEADER, String(MESH_RELAY_RESPONSE_FLOW_VERSION));
      const stream = await connector.openStream({
        kind: "http",
        method: (request.method ?? "GET").toUpperCase(),
        path,
        headers: sanitizeMeshRelayRequestHeaders(headers),
        targetNodeId: target,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return await performMeshRelayHttpRequest(stream, {
        body: request.body ?? null,
        responseFlowControl: true,
        ...(request.signal ? { signal: request.signal } : {}),
        onDispatch: request.onDispatch,
      });
    },

    openSocket(
      route: MeshPeerRoute,
      path: string,
      headers: Record<string, string>,
    ): MeshDuplexSocket {
      return new MeshRelayDuplexSocket(async (signal) => {
        const target = targetNodeId(route);
        const connector = resolve(route);
        return await connector.openStream({
          kind: "socket",
          path,
          headers: sanitizeMeshRelayRequestHeaders(headers),
          targetNodeId: target,
          signal,
        });
      });
    },
  };
}
