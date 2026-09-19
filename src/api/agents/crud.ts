/**
 * Scheduled-agent CRUD API routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { CreateAgentRequestSchema, UpdateAgentRequestSchema } from "@/contracts/schemas";
import { agentManager } from "../../core/agent-manager";
import { isGitBackedWorkspace } from "../../core/workspace-capabilities";
import { domainErrorResponse, errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { validateAgentModel } from "./helpers";

const log = createLogger("api:agents");

export const crudRoutes = defineRoutes({
  "/api/agents": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create scheduled agents.",
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const agents = await agentManager.getAgents(workspaceId);
      return Response.json(agents);
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateAgentRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data;
      const workspace = await requireWorkspace(body.workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }
      if (
        !isGitBackedWorkspace(workspace)
        && (body.useWorktree || body.baseBranch !== undefined)
      ) {
        return errorResponse(
          "workspace_git_required",
          "Directory workspaces do not support branches or worktrees.",
          409,
        );
      }
      const modelValidation = await validateAgentModel(body.workspaceId, body.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const agent = await agentManager.createAgent(body);
        return Response.json(agent, { status: 201 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "agents",
          fallback: {
            error: "create_agent_failed",
            message: "Failed to create agent",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to create agent", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        } else {
          log.warn("Rejected agent creation", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/agents/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a scheduled agent.",
    async GET(_req: Request, ctx): Promise<Response> {
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      return Response.json(agent);
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateAgentRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const existing = await agentManager.getAgent(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      const body = validation.data;
      if (body.model) {
        const modelValidation = await validateAgentModel(existing.config.workspaceId, body.model);
        if (modelValidation) {
          return modelValidation;
        }
      }

      try {
        const agent = await agentManager.updateAgent(ctx.params["id"]!, body);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "agents",
          fallback: {
            error: "update_agent_failed",
            message: "Failed to update agent",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to update agent", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        } else {
          log.warn("Rejected agent update", {
            agentId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await agentManager.deleteAgent(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to delete agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "delete_agent_failed",
          message: "Failed to delete agent",
          status: 500,
        });
      }
    },
  },

  "/api/agents/:id/code/draft": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the current generated deterministic agent draft.",
    async GET(_req: Request, ctx): Promise<Response> {
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      const code = await agentManager.getGenerationDraft(agent.config.id);
      return Response.json({ code: code ?? "" });
    },
  },
});
