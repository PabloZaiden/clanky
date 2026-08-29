/**
 * User-facing mesh membership and pairing management routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  ApproveMeshPairingRequestSchema,
  CompleteMeshPairingRequestSchema,
  RevokeMeshMemberRequestSchema,
  RejectMeshPairingRequestSchema,
  StartMeshPairingRequestSchema,
  UpdateMeshEndpointSchema,
  UpdateMeshInstanceNameSchema,
} from "@/contracts/schemas/mesh";
import { meshManager } from "../core/mesh-manager";
import { isDomainError } from "../core/domain-error";
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

export function meshErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    return domainErrorResponse(error, {
      fallback: {
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
        status: 500,
      },
      mappings: {
        mesh_pairing_request_not_found: {
          status: 404,
          message: "Mesh pairing request was not found",
        },
        mesh_pairing_request_not_owned: {
          status: 403,
          message: "Mesh pairing request is not owned by this user",
        },
        mesh_pairing_request_not_pending: {
          status: 409,
          message: "Mesh pairing request is no longer pending",
        },
        mesh_pairing_request_expired: {
          status: 410,
          message: "Mesh pairing request has expired",
        },
        mesh_pairing_request_not_targeted: {
          status: 403,
          message: "Mesh pairing request targets another local user",
        },
        mesh_pairing_request_not_incoming: {
          status: 409,
          message: "Only incoming mesh pairing requests can be approved here",
        },
        mesh_pairing_approval_not_found: {
          status: 409,
          message: "The peer has not approved this pairing request yet",
        },
        mesh_pairing_approval_not_pending: {
          status: 409,
          message: "The peer pairing approval is no longer pending",
        },
        mesh_pairing_fingerprint_mismatch: {
          status: 409,
          message: "The confirmed fingerprint does not match the peer approval",
        },
        mesh_instance_name_required: {
          status: 409,
          message: "Set an instance name before joining a mesh",
        },
        mesh_instance_name_invalid: {
          status: 400,
          message: "The mesh instance name is invalid",
        },
        mesh_control_request_rejected: {
          status: 502,
          message: "The peer rejected the mesh control request",
        },
        mesh_control_request_unreachable: {
          status: 503,
          message: "The mesh peer could not be reached",
        },
        mesh_public_base_url_not_configured: {
          status: 503,
          message: "Set CLANKY_PUBLIC_BASE_URL before using mesh pairing",
        },
        mesh_public_base_url_invalid: {
          status: 503,
          message: "CLANKY_PUBLIC_BASE_URL must be an absolute HTTP(S) origin without credentials, a path, a query, or a fragment",
        },
        mesh_endpoint_invalid: {
          status: 400,
          message: "The mesh endpoint must be a valid HTTP(S) URL without credentials, a query, or a fragment",
        },
        mesh_endpoint_protocol_invalid: {
          status: 400,
          message: "The mesh endpoint must use http or https",
        },
        mesh_endpoint_transport_mismatch: {
          status: 400,
          message: "The mesh endpoint protocol does not match its transport",
        },
        mesh_link_revoked: {
          status: 403,
          message: "The linked mesh membership has been revoked",
        },
        mesh_link_not_found: {
          status: 404,
          message: "The local user is not linked to a mesh",
        },
        mesh_node_not_member: {
          status: 404,
          message: "The node is not a member of this mesh",
        },
        mesh_instance_name_conflict: {
          status: 409,
          message: "Instance names must be unique within a mesh",
        },
        mesh_member_not_revoked: {
          status: 409,
          message: "Only a revoked mesh member can have its revocation deleted",
        },
        mesh_member_self_revoke_invalid: {
          status: 409,
          message: "This instance cannot revoke its own mesh identity",
        },
        mesh_pairing_rollback_failed: {
          status: 500,
          message: "Mesh pairing failed and local mesh state could not be rolled back",
        },
        mesh_rejoin_requires_revoked: {
          status: 409,
          message: "Only a revoked mesh node can rejoin",
        },
      },
    });
  }
  return domainErrorResponse(error, {
    fallback: {
      error: "mesh_operation_failed",
      message: "Mesh operation failed",
      status: 500,
    },
  });
}

export const meshRoutes = defineRoutes({
  "/api/mesh/members/revoke": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Revoke a mesh member and stop trusting its transport identity.",
    tags: ["mesh", "membership"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(RevokeMeshMemberRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const status = await meshManager.revokeMember(ctx.requireUser().id, parsed.data.nodeId);
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/members/:nodeId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Delete a revoked mesh member record so the node can be invited again.",
    tags: ["mesh", "membership"],
    async DELETE(_req, ctx): Promise<Response> {
      const nodeId = ctx.params["nodeId"];
      if (!nodeId) {
        return meshErrorResponse(new Error("Mesh node ID is required."));
      }
      try {
        const status = await meshManager.removeRevokedMember(ctx.requireUser().id, nodeId);
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/rejoin": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Rotate this revoked node identity and start a new mesh pairing flow.",
    tags: ["mesh", "membership"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(StartMeshPairingRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const user = ctx.requireUser();
        const status = await meshManager.rejoin(
          user.id,
          user.username,
          parsed.data,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/status": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Get local mesh identity, linked accounts, peers, and pairing state.",
    tags: ["mesh"],
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json(await meshManager.getStatus(ctx.requireUser().id));
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/health": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Check the reachability of current mesh transport peers.",
    tags: ["mesh", "health"],
    async POST(_req, ctx): Promise<Response> {
      try {
        const status = await meshManager.checkHealth(ctx.requireUser().id);
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/instance-name": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Set the persistent display name for this mesh instance.",
    tags: ["mesh", "identity"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(UpdateMeshInstanceNameSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const status = await meshManager.setInstanceName(
          ctx.requireUser().id,
          parsed.data.instanceName,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/endpoint": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Set the endpoint this instance advertises for Mesh traffic.",
    tags: ["mesh", "identity"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(UpdateMeshEndpointSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const status = await meshManager.setMeshEndpoint(
          ctx.requireUser().id,
          parsed.data.meshEndpoint,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/pairing-requests": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List pending mesh pairing requests for the current local user.",
    tags: ["mesh", "pairing"],
    async GET(_req, ctx): Promise<Response> {
      try {
        const status = await meshManager.getStatus(ctx.requireUser().id);
        return successResponse({
          requests: status.pendingPairingRequests,
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(StartMeshPairingRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const user = ctx.requireUser();
        const status = await meshManager.startPairing(
          user.id,
          user.username,
          parsed.data,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/pairing-requests/:requestId/approve": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Approve a pending mesh pairing request.",
    tags: ["mesh", "pairing"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(ApproveMeshPairingRequestSchema, req, {
        allowEmptyBody: true,
        emptyBodyValue: {},
      });
      if (!parsed.success) {
        return parsed.response;
      }
      const requestId = ctx.params["requestId"];
      if (!requestId) {
        return meshErrorResponse(new Error("Mesh pairing request ID is required."));
      }
      try {
        const status = await meshManager.approvePairingRequest(
          ctx.requireUser().id,
          requestId,
          parsed.data,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/pairing-requests/:requestId/complete": {
      auth: "user",
      sameOrigin: "mutations",
      description: "Confirm the peer fingerprint and complete an outgoing mesh pairing request.",
      tags: ["mesh", "pairing"],
      async POST(req, ctx): Promise<Response> {
        const parsed = await parseAndValidate(CompleteMeshPairingRequestSchema, req);
        if (!parsed.success) {
          return parsed.response;
        }
        const requestId = ctx.params["requestId"];
        if (!requestId) {
          return meshErrorResponse(new Error("Mesh pairing request ID is required."));
        }
        try {
          const status = await meshManager.completePairing(
            ctx.requireUser().id,
            requestId,
            parsed.data,
          );
          return successResponse({ status });
        } catch (error) {
          return meshErrorResponse(error);
        }
    },
  },

  "/api/mesh/pairing-requests/:requestId/reject": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Reject a pending mesh pairing request.",
    tags: ["mesh", "pairing"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(RejectMeshPairingRequestSchema, req, {
        allowEmptyBody: true,
        emptyBodyValue: {},
      });
      if (!parsed.success) {
        return parsed.response;
      }
      const requestId = ctx.params["requestId"];
      if (!requestId) {
        return meshErrorResponse(new Error("Mesh pairing request ID is required."));
      }
      try {
        const status = await meshManager.rejectPairingRequest(
          ctx.requireUser().id,
          requestId,
          parsed.data,
        );
        return successResponse({ status });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

});
