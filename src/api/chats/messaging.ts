import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import {
  ReplyToChatPermissionRequestSchema,
  SendChatMessageRequestSchema,
} from "@/contracts/schemas";
import { errorResponse, internalErrorResponse, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightChat } from "./helpers";

const log = createLogger("api:chats");

export const chatsMessagingRoutes = defineRoutes({
  "/api/chats/:id/messages": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Send a message to a chat session.",
    requestSchema: SendChatMessageRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const existing = await chatManager.getChatSummary(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(SendChatMessageRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const updated = await chatManager.sendMessage(ctx.params["id"]!, {
          message: validation.data.message ?? undefined,
          attachments: validation.data.attachments,
          credentialToken: validation.data.credentialToken,
        });
        return successResponse({
          chatId: ctx.params["id"]!,
          chat: await toLightweightChat(updated),
        });
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to send chat message", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "send_failed",
          message: "Failed to send chat message",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/queued-messages/:messageId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Delete a queued chat message.",
    async DELETE(_req: Request, ctx): Promise<Response> {
      try {
        const updated = await chatManager.removeQueuedMessage(ctx.params["id"]!, ctx.params["messageId"]!);
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(updated));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to remove queued chat message", {
          chatId: ctx.params["id"]!,
          messageId: ctx.params["messageId"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "remove_queued_message_failed",
          message: "Failed to remove queued chat message",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/permissions/:requestId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Approve or deny a pending chat permission request.",
    requestSchema: ReplyToChatPermissionRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const existing = await chatManager.getChat(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(ReplyToChatPermissionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const updated = await chatManager.replyToPermission(
          ctx.params["id"]!,
          ctx.params["requestId"]!,
          validation.data.decision,
        );
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(updated));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to reply to chat permission request", {
          chatId: ctx.params["id"]!,
          requestId: ctx.params["requestId"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "permission_reply_failed",
          message: "Failed to reply to chat permission request",
          status: 500,
        }, undefined, "chats");
      }
    },
  },
});
