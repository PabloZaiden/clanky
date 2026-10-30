import { workspaceOperation } from "../workspace-delegation";
import { createLogger, defineRoutes, getRequestOriginInfo, readRuntimeConfig } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import {
  ReplyToChatPermissionRequestSchema,
  SendChatMessageRequestSchema,
} from "@/contracts/schemas";
import { errorResponse, internalErrorResponse, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightChat } from "./helpers";
import { ReplyToChatQuestionRequestSchema } from "@/contracts/schemas/harness";
import { ReplyToSecretSchema } from "@/contracts/schemas/harness-secret";
import { SECRET_MAX_BYTES } from "@/shared/harness-secrets";
import { isDomainError } from "../../domain/domain-error";

const log = createLogger("api:chats");

function privateSecretResponse(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const chatsMessagingRoutes = defineRoutes({
  "/api/chats/:id/secrets/:requestId": {
    auth: "user",
    sameOrigin: "always",
    description: "Supply or decline a private secret using a real browser passkey session. Never records a chat answer.",
    tags: ["chats"],
    operations: {
      POST: {
        requestSchema: ReplyToSecretSchema,
        querySchema: undefined,
        automation: { policy: "excluded", reason: "Private human-only secret entry; never an agent operation." },
      },
    },
    async POST(req, ctx): Promise<Response> {
      const config = readRuntimeConfig({ appName: "Clanky", envPrefix: "CLANKY", appDirectoryName: ".clanky" });
      if (ctx.auth.kind !== "passkey" || config.passkeyDisabled
        || req.headers.get("origin") !== getRequestOriginInfo(req, config).origin) {
        return privateSecretResponse(errorResponse("secret_human_required", "Sign in with a browser passkey session to supply a secret.", 403));
      }
      const validation = await parseAndValidate(ReplyToSecretSchema, req, { maxBodyBytes: SECRET_MAX_BYTES * 6 + 1024 });
      if (!validation.success) {
        return privateSecretResponse(errorResponse("invalid_secret_response", "Provide a nonempty secret of at most 64 KiB, or decline.", 400));
      }
      try {
        const chat = await chatManager.replyToSecret(ctx.params["id"]!, ctx.params["requestId"]!, validation.data.value);
        return privateSecretResponse(successResponse({ chat: await toLightweightChat(chat) }));
      } catch (error) {
        const known = chatActionErrorResponse(error);
        log[known && known.status < 500 ? "warn" : "error"]("Private secret delivery failed", {
          code: isDomainError(error) ? error.code : "secret_reply_failed",
        });
        return privateSecretResponse(known ?? errorResponse("secret_reply_failed", "The private secret could not be delivered.", 500));
      }
    },
  },
  "/api/chats/:id/questions/:requestId": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Answer a pending owned chat question once.",
    tags: ["chats"],
    cliPath: "chats/:id/questions/:requestId",
    requestSchema: ReplyToChatQuestionRequestSchema,
    operations: {
      POST: {
        requestSchema: ReplyToChatQuestionRequestSchema,
        querySchema: undefined,
        automation: {
          policy: "write", hiddenInputs: ["clientId", "credentialToken"], completion: "admission",
          credential: {
            kind: "ssh", resource: { name: "chats", idParameter: "id", purpose: "connection" }, input: "credentialToken",
          },
        },
      },
    },
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(ReplyToChatQuestionRequestSchema, req);
      if (!validation.success) return validation.response;
      try {
        const chat = await chatManager.replyToQuestion(
          ctx.params["id"]!,
          ctx.params["requestId"]!,
          validation.data,
        );
        return successResponse({ chat: await toLightweightChat(chat) });
      } catch (error) {
        const known = chatActionErrorResponse(error);
        if (known) {
          log[known.status >= 500 ? "error" : "warn"]("Chat question response failed", { chatId: ctx.params["id"], error: String(error) });
          return known;
        }
        log.error("Chat question response failed", { chatId: ctx.params["id"], error: String(error) });
        return errorResponse("question_reply_failed", "The question could not be answered.", 500);
      }
    },
  },
  "/api/chats/:id/queued-messages/:messageId/reconcile": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Reconcile native admission of an owned input without sending it again.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "write", completion: "admission" } },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const result = await chatManager.reconcileQueuedMessage(ctx.params["id"]!, ctx.params["messageId"]!);
        return successResponse({ admission: result.admission, chat: await toLightweightChat(result.chat) });
      } catch (error) {
        const known = chatActionErrorResponse(error);
        if (known) return known;
        log.error("Native input recovery failed", { chatId: ctx.params["id"], error: String(error) });
        return errorResponse("input_recovery_failed", "Native input admission could not be recovered.", 500);
      }
    },
  },
  "/api/chats/:id/queued-messages/:messageId/steer": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Inject an existing queued message into the active native execution without restarting it.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "write", completion: "admission" } },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      try {
        const result = await chatManager.steerQueuedMessage(ctx.params["id"]!, ctx.params["messageId"]!);
        return successResponse({ admission: result.admission, chat: await toLightweightChat(result.chat) });
      } catch (error) {
        const known = chatActionErrorResponse(error);
        if (known) return known;
        log.error("Queued input steering failed", { chatId: ctx.params["id"], error: String(error) });
        return errorResponse("steer_failed", "Unable to determine native input admission. Refresh before retrying.", 500);
      }
    },
  },
  "/api/chats/:id/messages": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Send a message to a chat session.",
    requestSchema: SendChatMessageRequestSchema,
    operations: {
      POST: {
        requestSchema: SendChatMessageRequestSchema,
        querySchema: undefined,
        automation: {
          policy: "write",
          hiddenInputs: ["credentialToken", "clientId"],
          completion: "admission",
          credential: {
            kind: "ssh",
            resource: { name: "chats", idParameter: "id", purpose: "connection" },
            input: "credentialToken",
          },
        },
      },
    },
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
          clientId: validation.data.clientId,
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
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Delete a queued chat message.",
    operations: {
      DELETE: { requestSchema: undefined, querySchema: undefined, automation: { policy: "confirm", reason: "Deletes a queued instruction before delivery." } },
    },
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
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Approve or deny a pending chat permission request.",
    requestSchema: ReplyToChatPermissionRequestSchema,
    operations: {
      POST: {
        requestSchema: ReplyToChatPermissionRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "May grant the agent permission to act on the execution host.", completion: "admission" },
      },
    },
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
