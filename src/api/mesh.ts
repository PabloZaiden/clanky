/**
 * Controller and worker Mesh management routes.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  CreateMeshEnrollmentTokenRequestSchema,
  EnrollMeshWorkerRequestSchema,
  RevokeMeshWorkerRequestSchema,
  UpdateMeshEndpointSchema,
  UpdateMeshInstanceNameSchema,
} from "@/contracts/schemas/mesh";
import { meshManager } from "../core/mesh-manager";
import { isDomainError } from "../core/domain-error";
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

export function meshErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    const status = error.code === "mesh_worker_not_found"
      ? 404
      : error.code === "mesh_enrollment_token_invalid"
        || error.code === "mesh_enrollment_expired"
        ? 410
        : error.code === "mesh_enrollment_controller_mismatch"
          || error.code === "mesh_enrollment_self"
          ? 409
          : error.code === "mesh_role_invalid"
            ? 404
            : error.code === "mesh_peer_not_trusted"
              ? 403
              : error.code === "mesh_control_request_unreachable"
                ? 503
                : error.code === "mesh_worker_update_timeout"
                  ? 504
                  : error.code === "mesh_worker_update_failed"
                    ? 502
                : error.code === "mesh_control_request_rejected"
                  ? 502
                  : error.code.startsWith("mesh_")
                    ? 400
                    : 500;
    return domainErrorResponse(error, {
      fallback: {
        error: "mesh_operation_failed",
        message: "Mesh operation failed",
        status,
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
  "/api/mesh/status": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Get this controller's workers or this worker's local status.",
    tags: ["mesh"],
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json(await meshManager.getStatus(ctx.requireUser().id));
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/enrollment-tokens": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "List or create single-use worker enrollment tokens.",
    tags: ["mesh", "workers"],
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json(await meshManager.listEnrollmentTokens(ctx.requireOwner().id));
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(CreateMeshEnrollmentTokenRequestSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        return Response.json(
          await meshManager.createEnrollmentToken(
            ctx.requireOwner().id,
            parsed.data.name,
            parsed.data.ttlSeconds,
          ),
          { status: 201 },
        );
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/enroll": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Enroll this worker with a controller.",
    tags: ["mesh", "workers"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(EnrollMeshWorkerRequestSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const grant = await meshManager.enrollWithController({
          controllerEndpoint: parsed.data.controllerEndpoint,
          enrollmentToken: parsed.data.enrollmentToken,
          expectedFingerprint: parsed.data.expectedControllerFingerprint,
        });
        return successResponse({
          controller: {
            nodeId: grant.controllerNodeId,
            instanceName: grant.controllerInstanceName,
            fingerprint: grant.controllerFingerprint,
            status: grant.grantStatus,
          },
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/workers/revoke": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Revoke one controller-to-worker grant.",
    tags: ["mesh", "workers"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(RevokeMeshWorkerRequestSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        await meshManager.revokeWorker(ctx.requireOwner().id, parsed.data.workerNodeId);
        return successResponse({
          status: await meshManager.getControllerStatus(ctx.requireOwner().id),
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/workers/:workerNodeId": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Delete a revoked worker registration.",
    tags: ["mesh", "workers"],
    async DELETE(_req, ctx): Promise<Response> {
      const workerNodeId = ctx.params["workerNodeId"];
      if (!workerNodeId) {
        return domainErrorResponse(new Error("Worker node ID is required."), {
          fallback: {
            error: "mesh_worker_id_required",
            message: "Worker node ID is required.",
            status: 400,
          },
        });
      }
      try {
        await meshManager.removeRevokedWorker(ctx.requireOwner().id, workerNodeId);
        return successResponse({
          status: await meshManager.getControllerStatus(ctx.requireOwner().id),
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/workers/:workerNodeId/update": {
      auth: "owner",
      sameOrigin: "mutations",
      description: "Update and restart an enrolled Mesh worker.",
      tags: ["mesh", "workers", "update"],
      async POST(_req, ctx): Promise<Response> {
        const workerNodeId = ctx.params["workerNodeId"];
        if (!workerNodeId) {
          return domainErrorResponse(new Error("Worker node ID is required."), {
            fallback: {
              error: "mesh_worker_id_required",
              message: "Worker node ID is required.",
              status: 400,
            },
          });
        }
        try {
          return Response.json({
            success: true,
            update: await meshManager.updateWorker(ctx.requireOwner().id, workerNodeId),
          });
        } catch (error) {
          return meshErrorResponse(error);
        }
    },
  },
  "/api/mesh/health": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Probe enrolled workers without changing durable trust.",
    tags: ["mesh", "health"],
    async POST(_req, ctx): Promise<Response> {
      try {
        await meshManager.checkWorkerHealth(ctx.requireOwner().id);
        return successResponse({
          status: await meshManager.getControllerStatus(ctx.requireOwner().id),
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/instance-name": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Set this controller or worker display name.",
    tags: ["mesh", "identity"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(UpdateMeshInstanceNameSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        return successResponse({
          node: await meshManager.setInstanceName(parsed.data.instanceName),
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/endpoint": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Set this controller or worker advertised Mesh endpoint.",
    tags: ["mesh", "identity"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(UpdateMeshEndpointSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        return successResponse({
          node: await meshManager.setEndpoint(parsed.data.meshEndpoint),
        });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
});
