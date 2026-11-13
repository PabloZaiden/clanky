import { defineRoutes } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { isDomainError } from "../../domain/domain-error";
import { errorResponse, internalErrorResponse } from "../helpers";
import { workspaceOperation } from "../workspace-delegation";
import { chatActionErrorResponse } from "./helpers";
import { ChatDiffFileQuerySchema } from "@/contracts/schemas/chat";

const log = createLogger("api:chat-directory");

async function readChatDirectory(chatId: string, read: () => Promise<Response>): Promise<Response> {
  try {
    return await read();
  } catch (error) {
    if (isDomainError(error)) {
      if (error.code === "chat_not_found" || error.code === "chat_diff_file_not_found") {
        return errorResponse(error.code, error.message, 404);
      }
      if (error.code === "chat_directory_unavailable" || error.code === "chat_git_unavailable") {
        return errorResponse(error.code, error.message, 409);
      }
      if (error.code === "chat_document_read_failed" || error.code === "chat_repository_read_failed") {
        return errorResponse(error.code, error.message, 502);
      }
    }
    const known = chatActionErrorResponse(error);
    if (known) return known;
    log.error("Failed to read the chat execution directory", { chatId, error: String(error) });
    return internalErrorResponse(error, {
      error: "chat_directory_read_failed",
      message: "The chat's execution directory could not be read.",
      status: 502,
    }, undefined, "chats");
  }
}

export const chatsDirectoryRoutes = defineRoutes({
  "/api/chats/:id/diff": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "List committed and pending tracked/untracked changes without loading patches. Read a selected patch through the per-file operation. The comparison ref and commit are returned in X-Clanky-Diff-Base-Ref and X-Clanky-Diff-Base; untracked line counts are null until opened.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req, ctx) {
      const chatId = ctx.params["id"]!;
      return readChatDirectory(chatId, async () => {
        const diff = await chatManager.getDiff(chatId);
        return Response.json(diff.files, {
          headers: {
            "X-Clanky-Diff-Base": diff.base,
            "X-Clanky-Diff-Base-Ref": diff.baseRef,
            "Access-Control-Expose-Headers": "X-Clanky-Diff-Base, X-Clanky-Diff-Base-Ref",
          },
        });
      });
    },
  },
  "/api/chats/:id/diff/file": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read one changed file's patch and line counts on demand, using its repository-relative path and the comparison base from the change list.",
    operations: {
      GET: { requestSchema: undefined, querySchema: ChatDiffFileQuerySchema, automation: { policy: "read" } },
    },
    async GET(req, ctx) {
      const chatId = ctx.params["id"]!;
      const query = ChatDiffFileQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!query.success) {
        log.warn("Invalid per-file chat Diff request", { chatId });
        return errorResponse("validation_error", "Supply a changed file path and its comparison base.", 400);
      }
      return readChatDirectory(chatId, async () =>
        Response.json(await chatManager.getFileDiff(chatId, query.data.base, query.data.path)));
    },
  },
  "/api/chats/:id/plan": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read .clanky-planning/plan.md from the chat's execution directory without creating it.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req, ctx) {
      const chatId = ctx.params["id"]!;
      return readChatDirectory(chatId, async () => Response.json(await chatManager.getPlanningFile(chatId, "plan")));
    },
  },
  "/api/chats/:id/status-file": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the agent-maintained .clanky-planning/status.md document without creating it.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req, ctx) {
      const chatId = ctx.params["id"]!;
      return readChatDirectory(chatId, async () => Response.json(await chatManager.getPlanningFile(chatId, "status")));
    },
  },
  "/api/chats/:id/repository-context": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the actual current branch and an existing open pull request through the chat's execution host. Unavailable PR lookups are distinct from no PR.",
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(_req, ctx) {
      const chatId = ctx.params["id"]!;
      return readChatDirectory(chatId, async () => Response.json(await chatManager.getRepositoryContext(chatId)));
    },
  },
});
