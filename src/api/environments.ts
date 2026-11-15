import { createLogger } from "@pablozaiden/webapp/server";
import { defineRoutes } from "@/platform/server";
import {
  WorkspaceEnvironmentStatusSchema,
  RemoveWorkspaceEnvironmentRequestSchema,
  EnvironmentMutationResponseSchema,
} from "@/contracts/schemas/environments";
import { workspaceEnvironmentOperation } from "../core/environments/workspace-service";
import { domainErrorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";

const log = createLogger("api:environments");
function failure(error: unknown): Response {
  log.error("Managed environment operation failed", { error: String(error) });
  return domainErrorResponse(error, {
    policy: "execution-hosts",
    mappings: {
      environment_not_managed: { status: 409 },
      environment_operation_failed: { status: 502 },
    },
    fallback: { error: "environment_operation_failed", message: "Environment operation failed on its provisioning host.", status: 500 },
  });
}

export const environmentRoutes = defineRoutes({
  "/api/workspaces/:id/environment": {
    auth: "user", sameOrigin: "mutations",
    description: "Inspect or remove this workspace's owned container without deleting its source.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, responseSchema: WorkspaceEnvironmentStatusSchema, automation: { policy: "read" } },
      DELETE: {
        requestSchema: RemoveWorkspaceEnvironmentRequestSchema, querySchema: undefined,
        responseSchema: EnvironmentMutationResponseSchema,
        automation: { policy: "confirm", reason: "Stops and removes the workspace container, optionally destroying its private runtime credentials." },
      },
    },
    async GET(req, ctx) {
      try { return Response.json(await workspaceEnvironmentOperation(ctx.params["id"]!, "status", req.signal)); }
      catch (error) { return failure(error); }
    },
    async DELETE(req, ctx) {
      const validation = await parseAndValidate(RemoveWorkspaceEnvironmentRequestSchema, req);
      if (!validation.success) return validation.response;
      try {
        const result = await workspaceEnvironmentOperation(ctx.params["id"]!, "remove", req.signal, validation.data.resetCredentials);
        ctx.userRealtime.publishChanged(CLANKY_REALTIME_RESOURCES.workspaces);
        return Response.json(result);
      }
      catch (error) { return failure(error); }
    },
  },
  "/api/workspaces/:id/environment/stop": {
    auth: "user", sameOrigin: "mutations",
    description: "Stop this workspace's container through its provisioning host.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, responseSchema: EnvironmentMutationResponseSchema, automation: { policy: "confirm", reason: "Stops the container and interrupts its active agents and terminals." } },
    },
    async POST(req, ctx) {
      try {
        const result = await workspaceEnvironmentOperation(ctx.params["id"]!, "stop", req.signal);
        ctx.userRealtime.publishChanged(CLANKY_REALTIME_RESOURCES.workspaces);
        return Response.json(result);
      }
      catch (error) { return failure(error); }
    },
  },
});
