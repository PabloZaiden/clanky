import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { isModelEnabled } from "../../core/model-discovery";
import { getChatWorkspaceId, isWorkspaceChat } from "@/shared/chat";
import { SpawnCurrentPlanTaskRequestSchema } from "@/contracts/schemas";
import { errorResponse, internalErrorResponse, requireWorkspace } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightTask } from "./helpers";

const log = createLogger("api:chats");

export const chatsConversionRoutes = defineRoutes({
  "/api/chats/:id/spawn-task": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a task from an existing chat transcript.",
    async POST(_req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      if (!isWorkspaceChat(chat)) {
        return errorResponse("chat_not_workspace_backed", "Only workspace chats can create tasks", 409);
      }
      const workspace = await requireWorkspace(getChatWorkspaceId(chat));
      if (workspace instanceof Response) {
        return workspace;
      }

      const modelValidation = await isModelEnabled(
        workspace.id,
        chat.config.model.providerID,
        chat.config.model.modelID,
      );
      if (!modelValidation.enabled) {
        return errorResponse(
          modelValidation.errorCode ?? "model_not_enabled",
          modelValidation.error ?? "The selected model is not available",
        );
      }

      try {
        const task = await chatManager.spawnTaskFromChat(ctx.params["id"]!);
        return Response.json(await toLightweightTask(task), { status: 201 });
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to spawn task from chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "spawn_failed",
          message: "Failed to create a task from the chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/spawn-task-from-current-plan": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a task from the current plan discussed in a chat.",
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(SpawnCurrentPlanTaskRequestSchema, req, {
        allowEmptyBody: true,
      });
      if (!validation.success) {
        return validation.response;
      }

      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      if (!isWorkspaceChat(chat)) {
        return errorResponse("chat_not_workspace_backed", "Only workspace chats can create tasks", 409);
      }
      const workspace = await requireWorkspace(getChatWorkspaceId(chat));
      if (workspace instanceof Response) {
        return workspace;
      }

      const modelValidation = await isModelEnabled(
        workspace.id,
        chat.config.model.providerID,
        chat.config.model.modelID,
      );
      if (!modelValidation.enabled) {
        return errorResponse(
          modelValidation.errorCode ?? "model_not_enabled",
          modelValidation.error ?? "The selected model is not available",
        );
      }

      try {
        const task = await chatManager.spawnTaskFromCurrentPlan(ctx.params["id"]!, validation.data.planFilePath);
        return Response.json(await toLightweightTask(task), { status: 201 });
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to spawn task from current plan", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "spawn_failed",
          message: "Failed to create a task from the current chat plan",
          status: 500,
        }, undefined, "chats");
      }
    },
  },
});
