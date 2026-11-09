import { workspaceOperation } from "../workspace-delegation";
/**
 * Scheduled-automation CRUD API routes.
 */

import { defineRoutes } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import { CreateAutomationRequestSchema, UpdateAutomationRequestSchema } from "@/contracts/schemas";
import { automationManager } from "../../core/automation-manager";
import { isGitBackedWorkspace } from "../../core/workspace-capabilities";
import { domainErrorResponse, errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { validateAutomationModel } from "./helpers";
import { WorkspaceFilterQuerySchema } from "../route-schemas";

const log = createLogger("api:automations");

export const crudRoutes = defineRoutes({
  "/api/automations": {
    delegation: workspaceOperation("automation", { collection: true }),
    partialResults: { header: "X-Clanky-Partial" },
    auth: "user",
    sameOrigin: "mutations",
    description: "List or create scheduled automations.",
    operations: {
      GET: {
        description: "List scheduled automations, optionally filtered by workspace.",
        requestSchema: undefined,
        querySchema: WorkspaceFilterQuerySchema,
        automation: { policy: "read" },
      },
      POST: {
        description: "Create a scheduled automation.",
        requestSchema: CreateAutomationRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Enables recurring headless prompts or executable deterministic code." },
      },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
      const automations = await automationManager.getAutomations(workspaceId);
      return Response.json(automations);
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateAutomationRequestSchema, req);
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
      const modelValidation = await validateAutomationModel(body.workspaceId, body.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const automation = await automationManager.createAutomation(body);
        return Response.json(automation, { status: 201 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "automations",
          fallback: {
            error: "create_automation_failed",
            message: "Failed to create automation",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to create automation", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        } else {
          log.warn("Rejected automation creation", {
            workspaceId: body.workspaceId,
            error: String(error),
          });
        }
        return response;
      }
    },
  },

  "/api/automations/:id": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a scheduled automation.",
    operations: {
      GET: {
        description: "Read scheduled automation configuration and current state.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "read" },
      },
      PATCH: {
        description: "Update a scheduled automation.",
        requestSchema: UpdateAutomationRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "May enable recurring execution or replace executable automation code." },
      },
      DELETE: {
        description: "Delete a scheduled automation.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Permanently deletes the automation and its execution history.", completion: "admission" },
      },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const automation = await automationManager.getAutomation(ctx.params["id"]!);
      if (!automation) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      return Response.json(automation);
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(UpdateAutomationRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const existing = await automationManager.getAutomation(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      const body = validation.data;
      if (body.model) {
        const modelValidation = await validateAutomationModel(existing.config.workspaceId, body.model);
        if (modelValidation) {
          return modelValidation;
        }
      }

      try {
        const automation = await automationManager.updateAutomation(ctx.params["id"]!, body);
        if (!automation) {
          return errorResponse("automation_not_found", "Automation not found", 404);
        }
        return Response.json(automation);
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "automations",
          fallback: {
            error: "update_automation_failed",
            message: "Failed to update automation",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to update automation", {
            automationId: ctx.params["id"]!,
            error: String(error),
          });
        } else {
          log.warn("Rejected automation update", {
            automationId: ctx.params["id"]!,
            error: String(error),
          });
        }
        return response;
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const deleted = await automationManager.deleteAutomation(ctx.params["id"]!);
        if (!deleted) {
          return errorResponse("automation_not_found", "Automation not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to delete automation", {
          automationId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "delete_automation_failed",
          message: "Failed to delete automation",
          status: 500,
        });
      }
    },
  },

  "/api/automations/:id/code/draft": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the current generated deterministic automation draft.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const automation = await automationManager.getAutomation(ctx.params["id"]!);
      if (!automation) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      const code = await automationManager.getGenerationDraft(automation.config.id);
      return Response.json({ code: code ?? "" });
    },
  },
});
