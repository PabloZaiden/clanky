/**
 * Authenticated-by-signature mesh control routes.
 *
 * These routes are public at the framework boundary because a node has no
 * local user session on the peer yet. The handler requires a signed envelope,
 * matching node/request headers, endpoint policy, and explicit user approval
 * remains mandatory before membership becomes active.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  MeshPeerPairingApprovalSchema,
  MeshPeerPairingRequestSchema,
  MeshSyncPushSchema,
  MeshTakeoverEnvelopeSchema,
} from "@/contracts/schemas/mesh";
import { meshManager } from "../core/mesh-manager";
import { receiveMeshSyncPush } from "../core/mesh-sync-manager";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { isDomainError } from "../core/domain-error";

function internalMeshErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    const status = error.code === "mesh_pairing_request_expired"
      ? 410
      : error.code === "mesh_pairing_request_conflict"
        ? 409
        : error.code === "mesh_peer_not_trusted"
          ? 403
          : error.code === "mesh_link_not_found"
            ? 404
          : error.code === "mesh_peer_revoked"
            ? 403
        : error.code.startsWith("mesh_peer_") || error.code.startsWith("mesh_endpoint_")
          ? 400
          : error.code === "mesh_insecure_transport_disabled"
            || error.code === "mesh_insecure_transport_not_loopback"
            ? 400
            : 500;
    return errorResponse(error.code, error.message, status);
  }
  return errorResponse("mesh_internal_request_failed", "Mesh internal request failed", 500);
}

export const meshInternalRoutes = defineRoutes({
  "/api/mesh/internal/pairing-requests": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh pairing request from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshPeerPairingRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.requestedNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed request.", 400);
      }
      try {
        return Response.json(await meshManager.receivePairingRequest(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/pairing-approvals": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh pairing approval from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshPeerPairingApprovalSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.approvedByNodeId || requestId !== parsed.data.requestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed approval.", 400);
      }
      try {
        return Response.json(await meshManager.receivePairingApproval(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/sync": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive signed semantic mesh checkpoints from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshSyncPushSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      if (nodeId !== parsed.data.senderNodeId || requestId !== parsed.data.nonce) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed sync request.", 400);
      }
      try {
        return Response.json(await receiveMeshSyncPush(parsed.data, nodeId));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/takeover": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh takeover claim from another node.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshTakeoverEnvelopeSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      const nodeId = req.headers.get("x-clanky-mesh-node-id");
      const requestId = req.headers.get("x-clanky-mesh-request-id");
      const expectedRequestId = `${parsed.data.linkId}:${parsed.data.generation}:${parsed.data.senderNodeId}`;
      if (nodeId !== parsed.data.senderNodeId || requestId !== expectedRequestId) {
        return errorResponse("mesh_peer_headers_invalid", "Mesh identity headers do not match the signed takeover claim.", 400);
      }
      try {
        return Response.json(await meshManager.receiveTakeover(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
