/**
 * Inbound Mesh relay stream handling.
 *
 * Offers arrive on the control connection; this module dials the receiving
 * side of the ticketed stream and serves it either as an in-process HTTP
 * exchange or as an authorized Mesh gateway socket. Routes and methods are
 * re-validated locally even though the relay broker already allowlists them.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type {
  MeshRelayPeerRole,
  MeshRelayStreamOfferFrame,
} from "@/shared/mesh-relay";
import {
  closeMeshInboundSocket,
  openMeshInboundSocket,
  type MeshInboundSocket,
} from "./mesh-inbound-socket";
import type {
  MeshRelayInboundHandler,
  MeshRelayOfferContext,
} from "./mesh-relay-connector";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import { serveMeshRelayHttpStream } from "./mesh-relay-http";
import {
  isMeshRelayRouteAllowed,
  meshRelayInitiatorRole,
} from "./mesh-relay-policy";

const log = createLogger("core:mesh-relay-inbound");

export interface MeshRelayInboundOptions {
  /** Role of this node, used to derive which initiator role is expected. */
  role: MeshRelayPeerRole;
  /** In-process HTTP dispatcher, normally `WebAppServer.handleRequest`. */
  dispatch(request: Request): Promise<Response | undefined>;
}

async function serveSocketStream(
  stream: MeshRelayDataStream,
  offer: MeshRelayStreamOfferFrame,
): Promise<void> {
  const socket: MeshInboundSocket = {
    send: (data) => stream.send(data),
    close: (code, reason) => stream.close(code, reason),
  };
  const openingController = new AbortController();
  void stream.waitUntilClosed().then((item) => {
    openingController.abort(new MeshRelayStreamError(
      "mesh_relay_socket_open_aborted",
      item.reason || "The peer closed while the Mesh socket was starting.",
    ));
  });
  let attachment;
  try {
    attachment = await openMeshInboundSocket(
      offer.path,
      offer.headers,
      socket,
      openingController.signal,
    );
  } catch (error) {
    stream.close(1011, "The Mesh socket could not be authorized");
    stream.dispose();
    throw error;
  }
  try {
    while (true) {
      const item = await stream.next();
      if (item.kind === "closed") {
        return;
      }
      try {
        await attachment.message(item.kind === "text" ? item.text : item.bytes);
      } catch (error) {
        log.warn("An inbound Mesh relay socket frame was rejected", {
          path: attachment.path,
          error: String(error),
        });
        stream.close(1003, "Invalid Mesh socket frame");
        return;
      }
    }
  } finally {
    await closeMeshInboundSocket(attachment);
    stream.dispose();
  }
}

/**
 * Build the inbound handler a `MeshRelayConnector` uses for `stream.offer`.
 */
export function createMeshRelayInboundHandler(
  options: MeshRelayInboundOptions,
): MeshRelayInboundHandler {
  const initiatorRole = meshRelayInitiatorRole(options.role);
  return {
    async handleOffer(
      offer: MeshRelayStreamOfferFrame,
      context: MeshRelayOfferContext,
    ): Promise<void> {
      const pathname = new URL(
        offer.path.startsWith("/") ? offer.path : `/${offer.path}`,
        "https://mesh.invalid",
      ).pathname;
      const method = offer.method?.toUpperCase();
      if (!isMeshRelayRouteAllowed(initiatorRole, offer.kind, method, pathname)) {
        log.error("Refusing a Mesh relay offer for a route that is not allowed", {
          streamId: offer.streamId,
          kind: offer.kind,
          method: method ?? "none",
          path: pathname,
        });
        throw new MeshRelayStreamError(
          "mesh_relay_route_forbidden",
          `The Mesh relay offered a route that is not served here: ${pathname}`,
          { status: 403 },
        );
      }
      const stream = await context.openDataStream();
      if (offer.kind === "socket") {
        await serveSocketStream(stream, offer);
        return;
      }
      await serveMeshRelayHttpStream({
        stream,
        method: method!,
        path: offer.path,
        headers: offer.headers,
        initiatorNodeId: offer.initiatorNodeId,
        dispatch: options.dispatch,
        reportStatus: context.reportStatus,
      });
    },
  };
}
