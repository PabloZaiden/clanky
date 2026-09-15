/**
 * Owner-only controller relay pairing routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  ControllerRelayPairingStatusSchema,
  PairControllerRelayRequestSchema,
} from "@/contracts/schemas/mesh-relay";
import { controllerRelayService } from "../core/controller-relay-service";
import { domainErrorResponse } from "./helpers";
import { parseAndValidate } from "./validation";

function controllerRelayErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      mesh_relay_url_invalid: { status: 400 },
      mesh_relay_controller_mismatch: { status: 409 },
      mesh_relay_descriptor_too_large: { status: 413 },
      mesh_relay_descriptor_unreachable: { status: 502 },
      mesh_relay_descriptor_rejected: { status: 502 },
      mesh_relay_descriptor_invalid: { status: 502 },
      mesh_relay_pairing_auth_failed: { status: 401 },
      mesh_relay_authorization_failed: { status: 502 },
      mesh_relay_controller_identity_changed: { status: 409 },
      mesh_role_invalid: { status: 404 },
    },
    fallback: {
      error: "mesh_relay_operation_failed",
      message: "Mesh relay operation failed.",
      status: 500,
    },
  });
}

export const meshRelayRoutes = defineRoutes({
  "/api/mesh/relay": {
    auth: "owner",
    sameOrigin: "mutations",
    cliPath: "mesh/relay",
    description: "Inspect, pair, or unpair this controller's Mesh relay.",
    tags: ["mesh", "relay"],
    requestSchema: PairControllerRelayRequestSchema,
    responseSchema: ControllerRelayPairingStatusSchema,
    async GET(_req, ctx): Promise<Response> {
      ctx.requireOwner();
      try {
        return Response.json(await controllerRelayService.getStatus());
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
    async POST(req, ctx): Promise<Response> {
      ctx.requireOwner();
      const parsed = await parseAndValidate(PairControllerRelayRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        return Response.json(
          await controllerRelayService.pair(parsed.data.relayUrl),
          { status: 201 },
        );
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
    async DELETE(_req, ctx): Promise<Response> {
      ctx.requireOwner();
      try {
        return Response.json(await controllerRelayService.unpair());
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
  },
});
