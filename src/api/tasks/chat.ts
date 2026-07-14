import { defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { taskManager } from "../../core/task-manager";
import { createLogger } from "../../core/logger";
import { errorResponse } from "../helpers";

const log = createLogger("api:tasks:chat");

export const tasksChatRoutes = defineRoutes({
  "/api/tasks/:id/chat": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or create the chat session attached to a task.",
    async GET(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const chat = await chatManager.getTaskChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Task chat not found", 404);
      }

      return Response.json(chat);
    },

    async POST(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      try {
        const result = await chatManager.getOrCreateTaskChat(ctx.params["id"]!, task);
        return Response.json(result.chat, { status: result.created ? 201 : 200 });
      } catch (error) {
        log.error("Failed to get or create task chat", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return errorResponse("task_chat_failed", String(error), 500);
      }
    },
  },
});
