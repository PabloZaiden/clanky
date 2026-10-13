/**
 * API route for one-shot commands in a workspace execution context.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  WorkspaceExecRequestSchema,
  WorkspaceExecResponseSchema,
} from "@/contracts/schemas";
import { workspaceCommandService } from "../../core/workspace-command-service";
import {
  domainErrorResponse,
} from "../helpers";
import { parseAndValidate } from "../validation";

export const workspaceExecRoutes = defineRoutes({
  "/api/workspaces/:id/exec": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Execute one command on the host selected by a workspace.",
    tags: ["workspaces", "execution"],
    requestSchema: WorkspaceExecRequestSchema,
    operations: {
      POST: {
        requestSchema: WorkspaceExecRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Runs an arbitrary command with the selected execution host's account permissions." },
      },
    },
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
          policy: "workspaces",
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
