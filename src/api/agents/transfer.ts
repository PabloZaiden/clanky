/**
 * Scheduled-agent transfer API routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { AgentTransferPayloadSchema } from "@/contracts/schemas";
import { exportAgentConfig, getAgentTransferFilename, importAgentConfig } from "../../core/agent-transfer-service";
import { domainErrorResponse, errorResponse, requireWorkspace } from "../helpers";
import { parseAndValidate } from "../validation";
import { validateAgentModel } from "./helpers";

const log = createLogger("api:agents");

export const transferRoutes = defineRoutes({
  "/api/agents/:id/export": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Download a portable scheduled-agent configuration.",
    async GET(_req: Request, ctx): Promise<Response> {
      const payload = await exportAgentConfig(ctx.params["id"]!);
      if (!payload) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      return Response.json(payload, {
        headers: {
          "Content-Disposition": `attachment; filename="${getAgentTransferFilename(payload.agent.name)}"`,
        },
      });
    },
  },

  "/api/workspaces/:id/agents/import": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Import a portable scheduled-agent configuration into a workspace.",
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(AgentTransferPayloadSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const workspaceId = ctx.params["id"]!;
      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }
      const modelValidation = await validateAgentModel(workspaceId, validation.data.agent.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const agent = await importAgentConfig(workspaceId, validation.data);
        return Response.json(agent, { status: 201 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "agents",
          fallback: {
            error: "import_agent_failed",
            message: "Failed to import agent",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to import agent", {
            workspaceId,
            error: String(error),
          });
        } else {
          log.warn("Rejected agent import", {
            workspaceId,
            error: String(error),
          });
        }
        return response;
      }
    },
  },
});
