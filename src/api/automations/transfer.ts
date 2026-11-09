import { workspaceOperation } from "../workspace-delegation";
import { executionAutomation } from "../execution-automation";
/**
 * Scheduled-automation transfer API routes.
 */

import { defineRoutes } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import { AutomationTransferPayloadSchema } from "@/contracts/schemas";
import { exportAutomationConfig, getAutomationTransferFilename, importAutomationConfig } from "../../core/automation-transfer-service";
import { domainErrorResponse, errorResponse, requireWorkspace } from "../helpers";
import { parseAndValidate } from "../validation";
import { validateAutomationModel } from "./helpers";

const log = createLogger("api:automations");

export const transferRoutes = defineRoutes({
  "/api/automations/:id/export": {
    delegation: workspaceOperation("automation"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Download a portable scheduled-automation configuration.",
    operations: {
      GET: {
        requestSchema: undefined,
        querySchema: undefined,
        automation: executionAutomation("read", "Exports the portable scheduled-automation configuration."),
      },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const payload = await exportAutomationConfig(ctx.params["id"]!);
      if (!payload) {
        return errorResponse("automation_not_found", "Automation not found", 404);
      }
      return Response.json(payload, {
        headers: {
          "Content-Disposition": `attachment; filename="${getAutomationTransferFilename(payload.automation.name)}"`,
        },
      });
    },
  },

  "/api/workspaces/:id/automations/import": {
    delegation: workspaceOperation("automation", { parameterResource: "workspace" }),
    auth: "user",
    sameOrigin: "mutations",
    description: "Import a portable scheduled-automation configuration into a workspace.",
    operations: {
      POST: {
        requestSchema: AutomationTransferPayloadSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Imports scheduled prompts or executable code that may run automatically." },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(AutomationTransferPayloadSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const workspaceId = ctx.params["id"]!;
      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }
      const modelValidation = await validateAutomationModel(workspaceId, validation.data.automation.model);
      if (modelValidation) {
        return modelValidation;
      }

      try {
        const automation = await importAutomationConfig(workspaceId, validation.data);
        return Response.json(automation, { status: 201 });
      } catch (error) {
        const response = domainErrorResponse(error, {
          policy: "automations",
          fallback: {
            error: "import_automation_failed",
            message: "Failed to import automation",
            status: 500,
          },
        });
        if (response.status >= 500) {
          log.error("Failed to import automation", {
            workspaceId,
            error: String(error),
          });
        } else {
          log.warn("Rejected automation import", {
            workspaceId,
            error: String(error),
          });
        }
        return response;
      }
    },
  },
});
