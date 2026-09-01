/**
 * API route for one-shot commands in a workspace execution context.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  WorkspaceExecRequestSchema,
  WorkspaceExecResponseSchema,
} from "@/contracts/schemas";
import { workspaceCommandService } from "../../core/workspace-command-service";
import { domainErrorResponse } from "../helpers";
import { parseAndValidate } from "../validation";

export const workspaceExecRoutes = defineRoutes({
  "/api/workspaces/:id/exec": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Execute one command on the host selected by a workspace.",
    tags: ["workspaces", "execution"],
    requestSchema: WorkspaceExecRequestSchema,
    responseSchema: WorkspaceExecResponseSchema,
    async POST(req, ctx): Promise<Response> {
      const parsed = await parseAndValidate(WorkspaceExecRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        return Response.json(await workspaceCommandService.execute(
          ctx.params["id"]!,
          parsed.data,
          req.signal,
        ));
      } catch (error) {
        return domainErrorResponse(error, {
          mappings: {
            workspace_not_found: {
              status: 404,
            },
            workspace_exec_cwd_invalid: {
              status: 400,
            },
            workspace_exec_cwd_not_found: {
              status: 400,
            },
            workspace_exec_output_limit_exceeded: {
              status: 413,
            },
            mesh_execution_aborted: {
              status: 499,
              message: "Workspace command was aborted",
            },
            mesh_execution_unreachable: {
              status: 502,
              message: "Workspace execution host is unavailable",
            },
          },
          fallback: {
            error: "workspace_exec_failed",
            message: "Workspace command execution failed",
            status: 500,
          },
        });
      }
    },
  },
});
