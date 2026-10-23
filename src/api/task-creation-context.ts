/**
 * Authorized, credential-free task creation defaults for a selected workspace.
 * Browser-saved planning/model preferences remain explicit client inputs.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { TaskCreationContextResponseSchema } from "@/contracts/schemas/task-creation-context";
import { taskCreationService } from "../core/task-creation-service";
import { isDomainError } from "../domain/domain-error";
import { internalErrorResponse } from "./helpers";
import { workspaceOperation } from "./workspace-delegation";

const log = createLogger("api:task-creation-context");

export const taskCreationContextRoutes = defineRoutes({
  "/api/workspaces/:id/task-creation-context": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read task capabilities, effective creation defaults, model preferences and usable branches on the selected workspace host. Apply saved browser planning preferences or explicit user overrides before POST /api/tasks; nullable selections require attention.",
    responseSchema: TaskCreationContextResponseSchema,
    tags: ["workspaces", "tasks"],
    operations: {
      GET: {
        description: "Discover valid task creation inputs for this workspace without inventing models, branches or permission settings.",
        requestSchema: undefined,
        querySchema: undefined,
        responseSchema: TaskCreationContextResponseSchema,
        automation: { policy: "read" },
      },
    },
    async GET(_req, ctx): Promise<Response> {
      ctx.requireUser();
      const workspaceId = ctx.params["id"]!;
      try {
        const context = await taskCreationService.getCreationContext(workspaceId);
        return Response.json(context);
      } catch (error) {
        const notFound = isDomainError(error) && error.code === "workspace_not_found";
        const details = { workspaceId, code: isDomainError(error) ? error.code : "unknown" };
        if (notFound) {
          log.warn("Task creation context workspace was not found", details);
        } else {
          log.error("Failed to read task creation context", details);
        }
        return internalErrorResponse(error, {
          error: "task_creation_context_failed",
          message: "Failed to read task creation context",
          status: 500,
        }, {
          workspace_not_found: {
            error: "workspace_not_found",
            message: "Workspace not found",
            status: 404,
          },
        });
      }
    },
  },
});
