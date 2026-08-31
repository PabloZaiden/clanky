/**
 * Terminal session routes for tasks.
 *
 * - GET/POST /api/tasks/:id/terminal-session  - Get or create a terminal session for a task
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { taskManager } from "../../core/task-manager";
import { terminalSessionManager } from "../../core/terminal-session-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "../helpers";

const log = createLogger("api:tasks");

function mapTaskTerminalSessionError(error: unknown): Response {
  return domainErrorResponse(error, {
    mappings: {
      task_not_found: {
        error: "not_found",
        message: "Task not found",
        status: 404,
      },
      terminal_session_not_found: {
        error: "not_found",
        message: "Terminal session not found for task",
        status: 404,
      },
      task_working_directory_unavailable: {
        error: "invalid_session_configuration",
        status: 400,
      },
    },
    fallback: {
      error: "terminal_session_error",
      message: "Terminal session operation failed",
      status: 500,
    },
  });
}

export const tasksTerminalSessionRoutes = defineRoutes({
  "/api/tasks/:id/terminal-session": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or create a task-backed terminal session.",
    async GET(_req: Request, ctx): Promise<Response> {
      try {
        const task = await taskManager.getTask(ctx.params["id"]!);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        const session = await terminalSessionManager.getSessionByTaskId(ctx.params["id"]!);
        if (!session) {
          return errorResponse("not_found", "Terminal session not found for task", 404);
        }

        return Response.json(session);
      } catch (error) {
        log.error("GET /api/tasks/:id/terminal-session - Failed", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return mapTaskTerminalSessionError(error);
      }
    },

    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const session = await terminalSessionManager.getOrCreateTaskSession(ctx.params["id"]!);
        return Response.json(session);
      } catch (error) {
        log.error("POST /api/tasks/:id/terminal-session - Failed", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return mapTaskTerminalSessionError(error);
      }
    },
  },
});
