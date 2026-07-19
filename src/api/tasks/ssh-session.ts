import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * SSH session routes for tasks.
 *
 * - GET/POST /api/tasks/:id/ssh-session               - Get or create an SSH session for a task
 */

import { taskManager } from "../../core/task-manager";
import { sshSessionManager } from "../../core/ssh-session-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "../helpers";

const log = createLogger("api:tasks");

function mapTaskSshSessionError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      task_not_found: {
        error: "not_found",
        message: "Task not found",
        status: 404,
      },
      ssh_transport_required: {
        error: "invalid_session_configuration",
        status: 400,
      },
      task_working_directory_unavailable: {
        error: "invalid_session_configuration",
        status: 400,
      },
      ssh_session_not_found: {
        error: "not_found",
        message: "SSH session not found for task",
        status: 404,
      },
    },
    fallback: {
      error: "ssh_session_error",
      message: "SSH session operation failed",
      status: 500,
    },
  });
}

export const tasksSshSessionRoutes = defineRoutes({
  "/api/tasks/:id/ssh-session": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or create a task-backed SSH session.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const task = await taskManager.getTask(ctx.params["id"]!);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        const session = await sshSessionManager.getSessionByTaskId(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "SSH session not found for task", 404);
        }

        return Response.json(session);
      } catch (error) {
        log.error("GET /api/tasks/:id/ssh-session - Failed", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return mapTaskSshSessionError(error);
      }
    },

    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const session = await sshSessionManager.getOrCreateTaskSession(ctx.params["id"]!);
        return Response.json(session);
      } catch (error) {
        log.error("POST /api/tasks/:id/ssh-session - Failed", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return mapTaskSshSessionError(error);
      }
    },
  },
});
