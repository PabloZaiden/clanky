/**
 * API for temporary, workspace-exclusive Mesh worker reservations.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { CreateWorkspaceWorkerEnrollmentRequestSchema } from "@/contracts/schemas/mesh";
import { meshManager } from "../core/mesh-manager";
import { meshErrorResponse } from "./mesh";
import { domainErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { isDomainError } from "../core/domain-error";

export const workspaceWorkerEnrollmentRoutes = defineRoutes({
  "/api/workspace-worker-enrollments": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create workspace-exclusive Mesh worker enrollments.",
    requestSchema: CreateWorkspaceWorkerEnrollmentRequestSchema,
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json(
          await meshManager.listWorkspaceWorkerEnrollments(ctx.requireUser().id),
        );
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(
        CreateWorkspaceWorkerEnrollmentRequestSchema,
        req,
      );
      if (!parsed.success) return parsed.response;
      try {
        return Response.json(
          await meshManager.createWorkspaceWorkerEnrollment(
            ctx.requireUser().id,
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
  "/api/workspace-worker-enrollments/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or cancel a workspace-exclusive Mesh worker enrollment.",
    async GET(_req, ctx): Promise<Response> {
      try {
        return Response.json(
          await meshManager.getWorkspaceWorkerEnrollment(
            ctx.requireUser().id,
            ctx.params["id"]!,
          ),
        );
      } catch (error) {
        if (isDomainError(error) && error.code === "workspace_worker_enrollment_not_found") {
          return domainErrorResponse(error, {
            fallback: {
              error: "not_found",
              message: "Workspace worker enrollment not found",
              status: 404,
            },
          });
        }
        return meshErrorResponse(error);
      }
    },
    async DELETE(_req, ctx): Promise<Response> {
      try {
        await meshManager.cancelWorkspaceWorkerEnrollment(
          ctx.requireUser().id,
          ctx.params["id"]!,
        );
        return successResponse({ cancelled: true });
      } catch (error) {
        return meshErrorResponse(error);
      }
    },
  },
});
