import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { isStandaloneChat } from "@/shared/chat";
import {
  InterruptChatRequestSchema,
  ReconnectChatRequestSchema,
} from "@/contracts/schemas";
import { errorResponse, internalErrorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightChat } from "./helpers";

const log = createLogger("api:chats");

export const chatsLifecycleRoutes = defineRoutes({
  "/api/chats/:id/done": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Mark a standalone chat as done.",
    async POST(_req: Request, ctx): Promise<Response> {
      const chatId = ctx.params["id"]!;
      const existing = await chatManager.getChat(chatId);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      if (!isStandaloneChat(existing)) {
        return errorResponse(
          "chat_not_markable",
          "Only standalone chats can be marked as done",
          409,
        );
      }

      try {
        const updated = await chatManager.markChatDone(chatId);
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(updated));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to mark chat as done", { chatId, error: String(error) });
        return internalErrorResponse(error, {
          error: "mark_done_failed",
          message: "Failed to mark chat as done",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/interrupt": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Interrupt an active chat run.",
    requestSchema: InterruptChatRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const existing = await chatManager.getChat(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(InterruptChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const updated = await chatManager.interruptChat(ctx.params["id"]!, validation.data.reason);
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(updated));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to interrupt chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "interrupt_failed",
          message: "Failed to interrupt chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/reconnect": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Reconnect a chat session to its backend runtime.",
    requestSchema: ReconnectChatRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      try {
        const validation = await parseAndValidate(ReconnectChatRequestSchema, req, { allowEmptyBody: true });
        if (!validation.success) {
          return validation.response;
        }
        const reconnected = await chatManager.reconnectSession(ctx.params["id"]!, {
          credentialToken: validation.data.credentialToken,
        });
        if (!reconnected) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(reconnected));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to reconnect chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "reconnect_failed",
          message: "Failed to reconnect chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },
});
