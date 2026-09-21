import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  MeshEnrollmentRequestSchema,
  MeshHealthCheckSchema,
  MeshRevocationNoticeSchema,
  MeshWorkerKillRequestSchema,
} from "@/contracts/schemas/mesh";
import {
  MESH_RUNTIME_SNAPSHOT_HEADER,
  MESH_RUNTIME_SNAPSHOT_VERSION,
} from "@/shared/mesh";
import { meshManager } from "../../core/mesh-manager";
import { requireMeshRuntimeRole } from "../../core/mesh-runtime";
import { getMeshRelayRequestInitiatorNodeId } from "../../core/mesh-relay-http";
import { errorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import {
  internalMeshErrorResponse,
  validateMeshIdentityHeaders,
} from "./shared";

export const meshControlRoutes = defineRoutes({
  "/api/mesh/internal/enrollment": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed worker enrollment request.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshEnrollmentRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.workerNodeId,
        parsed.data.workerNodeId,
        "Mesh identity headers do not match the signed request.",
      );
      if (headerError) return headerError;
      const relayInitiatorNodeId = getMeshRelayRequestInitiatorNodeId(req);
      if (
        (relayInitiatorNodeId !== undefined && (
          parsed.data.protocolVersion !== 2
          || relayInitiatorNodeId !== parsed.data.workerNodeId
        ))
        || (relayInitiatorNodeId === undefined && parsed.data.protocolVersion === 2)
      ) {
        return errorResponse(
          "mesh_enrollment_relay_identity_mismatch",
          "Relay enrollment must use protocol v2 and originate from the signed worker identity.",
          403,
        );
      }
      try {
        requireMeshRuntimeRole("controller");
        return Response.json(await meshManager.receiveEnrollmentRequest(parsed.data));
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/revocation": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed revocation from an enrolled controller.",
    tags: ["mesh", "internal"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshRevocationNoticeSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.controllerNodeId,
        parsed.data.controllerNodeId,
        "Mesh identity headers do not match the signed revocation.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        await meshManager.receiveRevocationNotice(parsed.data);
        return Response.json({ success: true });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/kill": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed worker termination request from an enrolled controller.",
    tags: ["mesh", "internal", "lifecycle"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshWorkerKillRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.controllerNodeId,
        parsed.data.nonce,
        "Mesh identity headers do not match the worker kill request.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        await meshManager.receiveWorkerKillRequest(parsed.data);
        return Response.json({ success: true, message: "Worker is shutting down." });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/health": {
    auth: "public",
    sameOrigin: "never",
    description: "Receive a signed mesh transport health check from another node.",
    tags: ["mesh", "internal", "health"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshHealthCheckSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.senderNodeId,
        parsed.data.nonce,
        "Mesh identity headers do not match the signed health check.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        const includeRuntimeSnapshot =
          req.headers.get(MESH_RUNTIME_SNAPSHOT_HEADER)
            === String(MESH_RUNTIME_SNAPSHOT_VERSION);
        return Response.json(
          await meshManager.receiveHealthCheck(parsed.data, {
            includeRuntimeSnapshot,
          }),
          {
            headers: includeRuntimeSnapshot
              ? {
                  [MESH_RUNTIME_SNAPSHOT_HEADER]: String(
                    MESH_RUNTIME_SNAPSHOT_VERSION,
                  ),
                }
              : undefined,
          },
        );
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
