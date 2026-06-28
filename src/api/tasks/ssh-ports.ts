/**
 * SSH session routes for tasks.
 *
 * - GET/POST /api/tasks/:id/ssh-session               - Get or create an SSH session for a task
 */

import { taskManager } from "../../core/task-manager";
import { sshSessionManager } from "../../core/ssh-session-manager";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";

const log = createLogger("api:tasks");

function mapTaskSshSessionError(error: unknown): Response {
  const message = String(error);
  if (message.includes("Task not found")) {
    return errorResponse("not_found", "Task not found", 404);
  }
  if (
    message.includes("ssh transport")
    || message.includes("dtach is not available")
    || message.includes("Task working directory is not available")
  ) {
    return errorResponse("invalid_session_configuration", message, 400);
  }
  return errorResponse("ssh_session_error", message, 500);
}

export const tasksSshPortsRoutes = {
  "/api/tasks/:id/ssh-session": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const task = await taskManager.getTask(req.params.id);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        const session = await sshSessionManager.getSessionByTaskId(req.params.id);
        if (!session) {
          return errorResponse("not_found", "SSH session not found for task", 404);
        }

        return Response.json(session);
      } catch (error) {
        log.error("GET /api/tasks/:id/ssh-session - Failed", {
          taskId: req.params.id,
          error: String(error),
        });
        return mapTaskSshSessionError(error);
      }
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const session = await sshSessionManager.getOrCreateTaskSession(req.params.id);
        return Response.json(session);
      } catch (error) {
        log.error("POST /api/tasks/:id/ssh-session - Failed", {
          taskId: req.params.id,
          error: String(error),
        });
        return mapTaskSshSessionError(error);
      }
    },
  },
};
