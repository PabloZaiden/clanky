import { defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { taskManager } from "../../core/task-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { errorResponse, internalErrorResponse } from "../helpers";

const log = createLogger("api:tasks:chat");

export const tasksChatRoutes = defineRoutes({
  "/api/tasks/:id/chat": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read or create the chat session attached to a task.",
    async GET(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTaskSummary(ctx.params["id"]!);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const chat = await chatManager.getTaskChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Task chat not found", 404);
      }

      const responseChat = await chatManager.getChatSummary(chat.config.id);
      if (!responseChat) {
        return errorResponse("not_found", "Task chat not found", 404);
      }
      return Response.json(responseChat);
    },

    async POST(req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTaskSummary(ctx.params["id"]!);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      try {
        const result = await chatManager.getOrCreateTaskChat(ctx.params["id"]!, task);
        if (new URL(req.url).searchParams.get("summary") === "1") {
          return Response.json({
            chatId: result.chat.config.id,
            created: result.created,
          }, { status: result.created ? 201 : 200 });
        }
        const responseChat = await chatManager.getChatSummary(result.chat.config.id);
        if (!responseChat) {
          throw new Error(`Task chat disappeared after creation: ${result.chat.config.id}`);
        }
        return Response.json(responseChat, { status: result.created ? 201 : 200 });
      } catch (error) {
        log.error("Failed to get or create task chat", {
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "task_chat_failed",
          message: "Failed to create the task chat",
          status: 500,
        });
      }
    },
  },
});
