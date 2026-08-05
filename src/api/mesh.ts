/**
 * User-facing mesh membership and pairing management routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  ApproveMeshPairingRequestSchema,
  CompleteMeshPairingRequestSchema,
  MeshTakeoverRequestSchema,
  RevokeMeshMemberRequestSchema,
  RejectMeshPairingRequestSchema,
  ResolveMeshSyncConflictSchema,
  StartMeshPairingRequestSchema,
  UpdateMeshInstanceNameSchema,
} from "@/contracts/schemas/mesh";
import { meshManager } from "../core/mesh-manager";
import { isDomainError } from "../core/domain-error";
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { listMeshLinksForLocalUser } from "../persistence/mesh";
import { listOpenMeshSyncConflicts } from "../persistence/mesh-sync";
import { resolveMeshSyncConflict } from "../core/mesh-sync-service";
import { assertLocalMeshActive } from "../core/mesh-activity";

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
        linked_node_not_active: {
          status: 409,
          message: "This Clanky instance is not the active mesh node",
        },
        mesh_link_conflict: {
          status: 409,
          message: "The linked mesh has an unresolved authority conflict",
        },
        mesh_link_revoked: {
          status: 403,
          message: "The linked mesh membership has been revoked",
        },
        mesh_takeover_generation_conflict: {
          status: 409,
          message: "The mesh authority changed before takeover was confirmed",
        },
        mesh_takeover_conflict: {
          status: 409,
          message: "The mesh has conflicting authority claims",
        },
        mesh_link_not_found: {
          status: 404,
          message: "The local user is not linked to a mesh",
        },
        mesh_node_not_member: {
          status: 404,
          message: "The node is not a member of this mesh",
        },
        mesh_active_node_revoke_requires_takeover: {
          status: 409,
          message: "Replace the active node before revoking it",
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
    description: "Revoke a mesh member and stop sending new synchronized data to it.",
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
        await assertLocalMeshActive(user.id);
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
        await assertLocalMeshActive(ctx.requireUser().id);
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
        await assertLocalMeshActive(ctx.requireUser().id);
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

  "/api/mesh/conflicts": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List unresolved conflicts in linked mesh resources.",
    tags: ["mesh", "sync"],
    async GET(_req, ctx): Promise<Response> {
      try {
        const userId = ctx.requireUser().id;
        const links = await listMeshLinksForLocalUser(userId);
        const conflicts = [];
        for (const link of links) {
          conflicts.push(...await listOpenMeshSyncConflicts(link.linkId));
        }
        return successResponse({ conflicts });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/conflicts/:conflictId/resolve": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Resolve one linked mesh conflict explicitly.",
    tags: ["mesh", "sync"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(ResolveMeshSyncConflictSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const conflictId = ctx.params["conflictId"];
      if (!conflictId) {
        return meshErrorResponse(new Error("Mesh conflict ID is required."));
      }
      try {
        await assertLocalMeshActive(ctx.requireUser().id);
        const result = await resolveMeshSyncConflict(
          ctx.requireUser().id,
          conflictId,
          parsed.data.resolution,
        );
        return successResponse({ conflict: result });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/takeover/preflight": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Inspect mesh authority and active work before an explicit takeover.",
    tags: ["mesh", "authority"],
    async GET(_req, ctx): Promise<Response> {
      try {
        return successResponse(await meshManager.getTakeoverPreflight(ctx.requireUser().id));
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },

  "/api/mesh/takeover": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Explicitly claim this instance as the active node for the linked mesh.",
    tags: ["mesh", "authority"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(MeshTakeoverRequestSchema, req, {
        allowEmptyBody: true,
        emptyBodyValue: {},
      });
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const result = await meshManager.takeover(
          ctx.requireUser().id,
          parsed.data.expectedGeneration,
        );
        return successResponse(result);
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
});
