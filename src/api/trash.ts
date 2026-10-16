/**
 * Public, owner-scoped standalone chat recovery and permanent deletion.
 */
import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { ChatTrashPageSchema, ChatTrashQuerySchema, EmptyChatTrashResponseSchema } from "@/contracts/schemas/chat-trash";
import { chatManager } from "../core/chat-manager";
import { isDomainError } from "../domain/domain-error";
import { domainErrorResponse, errorResponse, successResponse } from "./helpers";

const log = createLogger("api:trash");
const SSH_CREDENTIAL_TOKEN_HEADER = "x-clanky-ssh-credential-token";

function trashError(error: unknown): Response {
  const known = isDomainError(error) && [
    "trashed_chat_not_found", "trash_cleanup_failed", "invalid_trash_cursor",
  ].includes(error.code);
  if (known && error.code !== "trash_cleanup_failed") log.warn("Trash operation failed", { code: error.code });
  else log.error("Trash operation failed", { error: String(error) });
  return domainErrorResponse(error, {
    mappings: {
      trashed_chat_not_found: { status: 404, message: "Chat not found in Trash" },
      trash_cleanup_failed: { status: 503, message: "External cleanup failed. The chat remains in Trash; try again when its host is available." },
      invalid_trash_cursor: { status: 400, message: "Invalid Trash cursor" },
    },
    fallback: { status: 500, error: "trash_operation_failed", message: "Trash operation failed" },
  });
}

export const trashRoutes = defineRoutes({
  "/api/trash": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Standalone chats in the current user's Trash.",
    tags: ["trash"],
    cliPath: "trash",
    operations: {
      GET: { querySchema: ChatTrashQuerySchema, responseSchema: ChatTrashPageSchema, automation: { policy: "read" } },
      DELETE: {
        responseSchema: EmptyChatTrashResponseSchema,
        automation: { policy: "confirm", reason: "Permanently deletes all chats currently in your Trash. Cannot be undone." },
      },
    },
    async GET(req) {
      const parsed = ChatTrashQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!parsed.success) {
        log.warn("Invalid Trash query");
        return errorResponse("invalid_trash_query", "Use a limit between 1 and 100 and a valid cursor.", 400);
      }
      try {
        return Response.json(chatManager.listTrash(parsed.data));
      } catch (error) {
        return trashError(error);
      }
    },
    async DELETE(req) {
      try {
        const result = await chatManager.emptyTrash({
          credentialToken: req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER),
        });
        return Response.json({ success: result.failedCount === 0, ...result });
      } catch (error) {
        return trashError(error);
      }
    },
  },
  "/api/trash/:id/restore": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Restore a chat without automatically resuming its work.",
    tags: ["trash"],
    cliPath: "trash/:id/restore",
    operations: { POST: { automation: { policy: "write" } } },
    async POST(_req, ctx) {
      try {
        await chatManager.restoreChat(ctx.params["id"]!);
        return successResponse();
      } catch (error) {
        return trashError(error);
      }
    },
  },
  "/api/trash/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Permanently delete one chat from Trash.",
    tags: ["trash"],
    cliPath: "trash/:id",
    operations: {
      DELETE: { automation: { policy: "confirm", reason: "Permanently deletes this chat and its managed worktree. Cannot be undone." } },
    },
    async DELETE(req, ctx) {
      try {
        const deleted = await chatManager.purgeTrashedChat(ctx.params["id"]!, req.headers.get(SSH_CREDENTIAL_TOKEN_HEADER));
        return deleted ? successResponse() : errorResponse("trashed_chat_not_found", "Chat not found in Trash", 404);
      } catch (error) {
        return trashError(error);
      }
    },
  },
});
