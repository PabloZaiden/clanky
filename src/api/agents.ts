import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Scheduled agents API routes.
 */

import type { AgentRunStatus } from "@/shared/agent";
import { AgentRunsQuerySchema, CreateAgentRequestSchema, DeleteAgentRunsRequestSchema, RunAgentRequestSchema, UpdateAgentRequestSchema } from "@/contracts/schemas";
import { agentManager } from "../core/agent-manager";
import { createLogger } from "../core/logger";
import { isModelEnabled } from "../core/model-discovery";
import { errorResponse, requireWorkspace, successResponse } from "./helpers";
import { parseAndValidate, validateRequest } from "./validation";

const log = createLogger("api:agents");

async function validateAgentModel(workspaceId: string, model: {
  providerID: string;
  modelID: string;
  variant?: string;
}): Promise<Response | null> {
  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  const modelValidation = await isModelEnabled(
    workspace.id,
    model.providerID,
    model.modelID,
  );
  if (!modelValidation.enabled) {
    return errorResponse(
      modelValidation.errorCode ?? "model_not_enabled",
      modelValidation.error ?? "The selected model is not available",
    );
  }
  return null;
}

function mapPurgeStatuses(body: {
  includeCompleted: boolean;
  includeFailed: boolean;
  includeSkipped: boolean;
  includeInterrupted: boolean;
  includeCancelled: boolean;
}): AgentRunStatus[] {
  const statuses: AgentRunStatus[] = [];
  if (body.includeCompleted) {
    statuses.push("completed");
  }
  if (body.includeFailed) {
    statuses.push("failed");
  }
  if (body.includeSkipped) {
    statuses.push("skipped");
  }
  if (body.includeInterrupted) {
    statuses.push("interrupted");
  }
  if (body.includeCancelled) {
    statuses.push("cancelled");
  }
  return statuses;
}

export const agentsRoutes = defineRoutes({
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
      const modelValidation = await validateAgentModel(body.workspaceId, body.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const agent = await agentManager.createAgent(body);
        return Response.json(agent, { status: 201 });
      } catch (error) {
        log.error("Failed to create agent", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return errorResponse("create_agent_failed", String(error), 500);
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
        log.error("Failed to update agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return errorResponse("update_agent_failed", String(error), 500);
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
        return errorResponse("delete_agent_failed", String(error), 500);
      }
    },
  },

  "/api/agents/:id/run": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Start an agent run immediately.",
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(RunAgentRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }

      try {
        const run = await agentManager.runNow(ctx.params["id"]!, validation.data.attachments);
        return Response.json(run, { status: 202 });
      } catch (error) {
        const message = String(error);
        if (message.includes("not found")) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        if (message.includes("active run")) {
          return errorResponse("agent_already_running", message, 409);
        }
        log.error("Failed to run agent", {
          agentId: ctx.params["id"]!,
          error: message,
        });
        return errorResponse("run_agent_failed", message, 500);
      }
    },
  },

  "/api/agents/:id/interrupt": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Interrupt an active agent run.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const run = await agentManager.interruptAgent(ctx.params["id"]!, "Agent run interrupted by user");
        if (!run) {
          return errorResponse("no_active_agent_run", "Agent does not have an active run", 409);
        }
        return Response.json(run);
      } catch (error) {
        const message = String(error);
        if (message.includes("cannot be interrupted yet")) {
          return errorResponse("agent_run_not_ready", message, 409);
        }
        log.error("Failed to interrupt agent", {
          agentId: ctx.params["id"]!,
          error: message,
        });
        return errorResponse("interrupt_agent_failed", message, 500);
      }
    },
  },

  "/api/agents/:id/pause": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Pause a scheduled agent.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const agent = await agentManager.pauseAgent(ctx.params["id"]!);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        log.error("Failed to pause agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return errorResponse("pause_agent_failed", String(error), 500);
      }
    },
  },

  "/api/agents/:id/resume": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Resume a paused scheduled agent.",
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const agent = await agentManager.resumeAgent(ctx.params["id"]!);
        if (!agent) {
          return errorResponse("agent_not_found", "Agent not found", 404);
        }
        return Response.json(agent);
      } catch (error) {
        log.error("Failed to resume agent", {
          agentId: ctx.params["id"]!,
          error: String(error),
        });
        return errorResponse("resume_agent_failed", String(error), 500);
      }
    },
  },

  "/api/agents/:id/runs": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List or purge runs for an agent.",
    async GET(req: Request, ctx): Promise<Response> {
      const parsedQuery = validateRequest(
        AgentRunsQuerySchema,
        Object.fromEntries(new URL(req.url).searchParams),
      );
      if (!parsedQuery.success) {
        return parsedQuery.response;
      }
      const agent = await agentManager.getAgent(ctx.params["id"]!);
      if (!agent) {
        return errorResponse("agent_not_found", "Agent not found", 404);
      }
      const runs = await agentManager.listRuns(ctx.params["id"]!, parsedQuery.data);
      return Response.json(runs);
    },

    async DELETE(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(DeleteAgentRunsRequestSchema, req, { allowEmptyBody: true });
      if (!validation.success) {
        return validation.response;
      }
      const statuses = mapPurgeStatuses(validation.data);
      if (statuses.length === 0) {
        return successResponse({ deletedRunIds: [] });
      }
      const deletedRunIds = await agentManager.purgeRuns(ctx.params["id"]!, {
        before: validation.data.before,
        statuses,
      });
      return successResponse({ deletedRunIds });
    },
  },

  "/api/agent-runs/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or delete an agent run.",
    async GET(_req: Request, ctx): Promise<Response> {
      const run = await agentManager.getRun(ctx.params["id"]!);
      if (!run) {
        return errorResponse("agent_run_not_found", "Agent run not found", 404);
      }
      return Response.json(run);
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      const deleted = await agentManager.deleteRun(ctx.params["id"]!);
      if (!deleted) {
        return errorResponse("agent_run_not_found", "Agent run not found", 404);
      }
      return successResponse();
    },
  },
});
