import { defineRoutes } from "@/platform/server";
import { MESH_RELAY_CONTROL_PATH, MESH_RELAY_STREAM_PATH } from "@/shared/mesh-relay";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";
import { controllerWorkerConnectionService } from "../core/controller-worker-connection-service";
import { createRelayWebSocketHandler, hasValidControlQuery, hasValidStreamQuery } from "../core/mesh-relay-server";
import { isSecureMeshRequest } from "../core/mesh-transport-security";
import { meshErrorResponse } from "./mesh";
import { RELAY_MAX_DATA_FRAME_BYTES, RELAY_MAX_QUEUED_BYTES } from "../core/mesh-relay-broker";

// Public WSS upgrades authenticate Mesh identities, not application cookies.
// Reuse the relay wire adapter with the controller's own broker and identity.
export const meshOutboundRoutes = defineRoutes({
  [MESH_RELAY_CONTROL_PATH]: {
    auth: "public",
    sameOrigin: "never",
    catalog: false,
    GET(request, ctx) {
      if (!isSecureMeshRequest(request)) {
        return Response.json({ error: "mesh_tls_required" }, { status: 403 });
      }
      if (!hasValidControlQuery(new URL(request.url))) {
        return new Response("Unsupported Mesh generation", { status: 406 });
      }
      try {
        controllerWorkerConnectionService.getBroker();
        return ctx.server?.upgrade(request, {
          data: {
            webappSocketHandler: "meshOutbound",
            relaySocketKind: "control",
            relayProtocolVersion: MESH_PROTOCOL_VERSION,
          },
        }) ? undefined : new Response("WebSocket upgrade required", { status: 426 });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  [MESH_RELAY_STREAM_PATH]: {
    auth: "public",
    sameOrigin: "never",
    catalog: false,
    GET(request, ctx) {
      if (!isSecureMeshRequest(request)) {
        return Response.json({ error: "mesh_tls_required" }, { status: 403 });
      }
      const url = new URL(request.url);
      if (!hasValidStreamQuery(url)) {
        return new Response("Invalid Mesh stream ticket", { status: 401 });
      }
      try {
        const broker = controllerWorkerConnectionService.getBroker();
        const reservation = broker.reserveDataSocket(
          url.searchParams.get("ticket")!,
          url.searchParams.get("credential")!,
        );
        if (!reservation) {
          return new Response("Invalid or expired Mesh stream ticket", { status: 401 });
        }
        if (ctx.server?.upgrade(request, {
          data: {
            webappSocketHandler: "meshOutbound",
            relaySocketKind: "data",
            relayDataReservationId: reservation.reservationId,
          },
        })) {
          return undefined;
        }
        broker.closeData(reservation.reservationId, 1011, "WebSocket upgrade failed");
        return new Response("WebSocket upgrade required", { status: 426 });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
});

export const meshOutboundHandlers = {
  maxPayloadLength: RELAY_MAX_DATA_FRAME_BYTES,
  backpressureLimit: RELAY_MAX_QUEUED_BYTES,
  closeOnBackpressureLimit: true,
  idleTimeout: 60,
  open(...args: Parameters<NonNullable<ReturnType<typeof createRelayWebSocketHandler>["open"]>>) {
    controllerWorkerConnectionService.getWebSocketHandler().open?.(...args);
  },
  message(...args: Parameters<NonNullable<ReturnType<typeof createRelayWebSocketHandler>["message"]>>) {
    controllerWorkerConnectionService.getWebSocketHandler().message?.(...args);
  },
  close(...args: Parameters<NonNullable<ReturnType<typeof createRelayWebSocketHandler>["close"]>>) {
    controllerWorkerConnectionService.getWebSocketHandler().close?.(...args);
  },
};
