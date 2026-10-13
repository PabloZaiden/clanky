/**
 * Owner-only controller relay pairing routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  ControllerRelayPairingStatusSchema,
  PairControllerRelayRequestSchema,
  SelectPrimaryControllerRelayRequestSchema,
} from "@/contracts/schemas/mesh-relay";
import { controllerRelayService } from "../core/controller-relay-service";
import { domainErrorResponse } from "./helpers";
import { parseAndValidate } from "./validation";

function controllerRelayErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "mesh-relay",
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
    description: "Inspect or pair named Mesh relays for this controller.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Mesh relay pairing and trust configuration are managed outside model operations." } },
      POST: { requestSchema: PairControllerRelayRequestSchema, querySchema: undefined, automation: { policy: "excluded", reason: "Establishes Mesh relay trust; pairing is managed outside model operations." } },
    },
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
        const status = await controllerRelayService.pair(
          parsed.data.name,
          parsed.data.relayUrl,
        );
        ctx.userRealtime.publishChanged("mesh");
        return Response.json(status, { status: 201 });
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
  },
  "/api/mesh/relay/primary": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Select the primary Mesh relay used by default for invitations.",
    operations: {
      POST: { requestSchema: SelectPrimaryControllerRelayRequestSchema, querySchema: undefined, automation: { policy: "excluded", reason: "Primary Mesh relay trust routing is managed outside model operations." } },
    },
    tags: ["mesh", "relay"],
    requestSchema: SelectPrimaryControllerRelayRequestSchema,
    responseSchema: ControllerRelayPairingStatusSchema,
    async POST(req, ctx): Promise<Response> {
      ctx.requireOwner();
      const parsed = await parseAndValidate(SelectPrimaryControllerRelayRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const status = await controllerRelayService.selectPrimary(parsed.data.name);
        ctx.userRealtime.publishChanged("mesh");
        return Response.json(status);
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
  },
  "/api/mesh/relay/:name": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Unpair a named Mesh relay without changing worker enrollments.",
    operations: {
      DELETE: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Mesh relay trust revocation is managed outside model operations." } },
    },
    tags: ["mesh", "relay"],
    responseSchema: ControllerRelayPairingStatusSchema,
    async DELETE(_req, ctx): Promise<Response> {
      ctx.requireOwner();
      try {
        const status = await controllerRelayService.unpair(ctx.params["name"]!);
        ctx.userRealtime.publishChanged("mesh");
        return Response.json(status);
      } catch (error) {
        return controllerRelayErrorResponse(error);
      }
    },
  },
});
