import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Task collection routes.
 */

import { isDomainError } from "../../core/domain-error";
import { createLogger } from "../../core/logger";
import {
  TaskCreationStartError,
  taskCreationService,
} from "../../core/task-creation-service";
import { taskManager } from "../../core/task-manager";
import { CreateTaskRequestSchema, GenerateTaskTitleRequestSchema } from "@/contracts/schemas";
import { errorResponse, internalErrorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { startErrorResponse } from "./helpers";

const log = createLogger("api:tasks");

function mapTaskCreationError(error: unknown, workspaceId: string): Response | null {
  if (!isDomainError(error)) {
    return null;
  }

  if (error.code === "workspace_not_found") {
    return errorResponse("workspace_not_found", `Workspace not found: ${workspaceId}`, 404);
  }

  return errorResponse(error.code, error.message, 400);
}

export const tasksCollectionRoutes = defineRoutes({
  "/api/tasks": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List tasks or create a new task.",
    requestSchema: CreateTaskRequestSchema,
    async GET(_req: Request): Promise<Response> {
      log.debug("GET /api/tasks - Listing all tasks");
      const tasks = await taskManager.getTaskSummaries();
      log.debug("GET /api/tasks - Retrieved tasks", { count: tasks.length });
      return Response.json(tasks);
    },

    async POST(req: Request, _ctx): Promise<Response> {
      log.debug("POST /api/tasks - Creating new task");

      const validation = await parseAndValidate(CreateTaskRequestSchema, req);
      if (!validation.success) {
        log.debug("POST /api/tasks - Validation failed");
        return validation.response;
      }

      const body = validation.data;
      log.debug("POST /api/tasks - Request validated", {
        name: body.name,
        workspaceId: body.workspaceId,
        planMode: body.uploadedPlan ? true : body.planMode,
        draft: body.draft,
        hasModel: !!body.model,
        hasUploadedPlan: !!body.uploadedPlan,
      });

      try {
        const task = await taskCreationService.create(body);
        return Response.json(task, { status: 201 });
      } catch (error) {
        if (error instanceof TaskCreationStartError) {
          const startDetails = error.phase === "uploaded_plan"
            ? {
                fallbackCode: "start_uploaded_plan_failed",
                fallbackMessage: "Task created but failed to start from uploaded plan",
                planMode: true,
              }
            : error.phase === "plan"
              ? {
                  fallbackCode: "start_plan_failed",
                  fallbackMessage: "Task created but failed to start plan mode",
                  planMode: true,
                }
              : {
                  fallbackCode: "start_failed",
                  fallbackMessage: "Task created but failed to start",
                  planMode: false,
                };
          return startErrorResponse(
            error.originalError,
            startDetails.fallbackCode,
            startDetails.fallbackMessage,
            {
              taskId: error.taskId,
              planMode: startDetails.planMode,
            },
          );
        }

        const domainResponse = mapTaskCreationError(error, body.workspaceId);
        if (domainResponse) {
          return domainResponse;
        }

        log.error("Failed to create task", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "create_failed",
          message: "Failed to create task",
          status: 500,
        });
      }
    },
  },

  "/api/tasks/title": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Generate a task title from a prompt.",
    requestSchema: GenerateTaskTitleRequestSchema,
    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(GenerateTaskTitleRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const title = await taskCreationService.generateTitle(validation.data);
        return Response.json({ title });
      } catch (error) {
        if (isDomainError(error) && error.code === "workspace_not_found") {
          return errorResponse(
            "workspace_not_found",
            `Workspace not found: ${validation.data.workspaceId}`,
            404,
          );
        }

        log.error("Failed to generate task title", {
          workspaceId: validation.data.workspaceId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "title_generation_failed",
          message: "Failed to generate task title",
          status: 500,
        });
      }
    },
  },
});
