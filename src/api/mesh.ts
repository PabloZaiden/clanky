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
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

export function meshErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "mesh",
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
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
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
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Lists private Mesh enrollment credentials." } },
      POST: { requestSchema: CreateMeshEnrollmentTokenRequestSchema, querySchema: undefined, automation: { policy: "excluded", reason: "Creates private Mesh enrollment credentials." } },
    },
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
            parsed.data.route,
            parsed.data.relayName,
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
    operations: {
      POST: { requestSchema: EnrollMeshWorkerRequestSchema, querySchema: undefined, automation: { policy: "excluded", reason: "Mesh trust enrollment consumes private invitation credentials." } },
    },
    tags: ["mesh", "workers"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(EnrollMeshWorkerRequestSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const grant = await meshManager.enrollWithController({
          target: parsed.data.target,
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
    operations: {
      POST: { requestSchema: RevokeMeshWorkerRequestSchema, querySchema: undefined, automation: { policy: "excluded", reason: "Mesh trust grant management remains an explicit owner credential operation." } },
    },
    tags: ["mesh", "workers"],
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(RevokeMeshWorkerRequestSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        await meshManager.revokeWorker(ctx.requireOwner().id, parsed.data.workerNodeId);
        return successResponse();
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
  "/api/mesh/workers/:workerNodeId/kill": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Ask an enrolled worker to terminate so its service supervisor can restart it.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Terminates the worker process and interrupts its current work.", completion: "admission" } },
    },
    tags: ["mesh", "workers", "lifecycle"],
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
        await meshManager.killWorker(ctx.requireOwner().id, workerNodeId);
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
    operations: {
      DELETE: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Permanently deletes a revoked worker registration." } },
    },
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
  "/api/mesh/health": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Probe enrolled workers without changing durable trust.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
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
    operations: {
      POST: { requestSchema: UpdateMeshInstanceNameSchema, querySchema: undefined, automation: { policy: "write" } },
    },
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
    operations: {
      POST: { requestSchema: UpdateMeshEndpointSchema, querySchema: undefined, automation: { policy: "confirm", reason: "Changes the network endpoint advertised to connected Mesh nodes." } },
    },
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
