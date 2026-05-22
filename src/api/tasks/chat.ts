import { chatManager } from "../../core/chat-manager";
import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";

const log = createLogger("api:tasks:chat");

export const tasksChatRoutes = {
  "/api/tasks/:id/chat": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const chat = await chatManager.getTaskChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Task chat not found", 404);
      }

      return Response.json(chat);
    },

    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      try {
        const result = await chatManager.getOrCreateTaskChat(req.params.id, task);
        return Response.json(result.chat, { status: result.created ? 201 : 200 });
      } catch (error) {
        log.error("Failed to get or create task chat", {
          taskId: req.params.id,
          error: String(error),
        });
        return errorResponse("task_chat_failed", String(error), 500);
      }
    },
  },
};
