/**
 * SSH session and port-forward routes for tasks.
 *
 * - GET/POST /api/tasks/:id/ssh-session               - Get or create an SSH session for a task
 * - GET/POST /api/tasks/:id/port-forwards             - List or create port forwards for a task
 * - DELETE   /api/tasks/:id/port-forwards/:forwardId  - Delete a specific port forward
 */

import { taskManager } from "../../core/task-manager";
import { sshSessionManager } from "../../core/ssh-session-manager";
import { portForwardManager } from "../../core/port-forward-manager";
import { createLogger } from "../../core/logger";
import { parseAndValidate } from "../validation";
import { errorResponse, successResponse } from "../helpers";
import { CreatePortForwardRequestSchema } from "../../types/schemas";

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

function mapTaskPortForwardError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Task not found")) {
    return errorResponse("not_found", "Task not found", 404);
  }
  if (message.includes("Port forward not found")) {
    return errorResponse("not_found", "Port forward not found", 404);
  }
  if (message.includes("already being forwarded for this workspace")) {
    return errorResponse("duplicate_port_forward", message, 409);
  }
  if (message.includes("ssh transport")) {
    return errorResponse("invalid_port_forward_configuration", message, 400);
  }
  return errorResponse("port_forward_error", message, 500);
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

  "/api/tasks/:id/port-forwards": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        const task = await taskManager.getTask(req.params.id);
        if (!task) {
          return errorResponse("not_found", "Task not found", 404);
        }

        const forwards = await portForwardManager.listTaskPortForwards(req.params.id);
        return Response.json(forwards);
      } catch (error) {
        log.error("GET /api/tasks/:id/port-forwards - Failed", {
          taskId: req.params.id,
          error: String(error),
        });
        return mapTaskPortForwardError(error);
      }
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(CreatePortForwardRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const forward = await portForwardManager.createTaskPortForward({
          taskId: req.params.id,
          remotePort: validation.data.remotePort,
        });
        return Response.json(forward, { status: 201 });
      } catch (error) {
        log.error("POST /api/tasks/:id/port-forwards - Failed", {
          taskId: req.params.id,
          error: String(error),
        });
        return mapTaskPortForwardError(error);
      }
    },
  },

  "/api/tasks/:id/port-forwards/:forwardId": {
    async DELETE(req: Request & { params: { id: string; forwardId: string } }): Promise<Response> {
      try {
        const forward = await portForwardManager.getPortForward(req.params.forwardId);
        if (!forward || forward.config.taskId !== req.params.id) {
          return errorResponse("not_found", "Port forward not found", 404);
        }

        await portForwardManager.deletePortForward(req.params.forwardId);
        return successResponse();
      } catch (error) {
        log.error("DELETE /api/tasks/:id/port-forwards/:forwardId - Failed", {
          taskId: req.params.id,
          forwardId: req.params.forwardId,
          error: String(error),
        });
        return mapTaskPortForwardError(error);
      }
    },
  },
};
