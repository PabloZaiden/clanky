import { workspaceOperation } from "../workspace-delegation";
import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { isDomainError } from "../../domain/domain-error";
import { isModelEnabled } from "../../core/model-discovery";
import { preferencesManager } from "../../core/preferences-manager";
import { getChatWorkspaceId, isStandaloneChat, isTaskChat, isWorkspaceChat, type ChatConfig } from "@/shared/chat";
import {
  CreateChatRequestSchema,
  UpdateChatRequestSchema,
} from "@/contracts/schemas";
import { errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightChat } from "./helpers";
import { WorkspaceFilterQuerySchema } from "../route-schemas";
import { CollectionReadOptionsSchema, WorkCollectionReadOptionsSchema } from "@/contracts/schemas/resource-read";
import { readWorkCollection, readWorkCollectionItem } from "../../core/work-read-service";
import { readScope } from "../../client-sdk/collaboration/resource-read";
import { resourcePageResponse, workMetadataResponse } from "../resource-reads";

const log = createLogger("api:chats");

function mapChatUpdates(
  body: Partial<ChatConfig>,
): Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId">> {
  const updates: Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId">> = {};

  if (body.name !== undefined) {
    updates.name = body.name.trim();
  }
  if (body.model !== undefined) {
    updates.model = {
      providerID: body.model.providerID,
      modelID: body.model.modelID,
      variant: body.model.variant,
    };
  }
  if (body.baseBranch !== undefined) {
    updates.baseBranch = body.baseBranch;
  }
  if (body.useWorktree !== undefined) {
    updates.useWorktree = body.useWorktree;
  }
  if (body.isPrivate !== undefined) {
    updates.isPrivate = body.isPrivate;
  }

  return updates;
}

async function validateQuickChatRequestModel(body: {
  workspaceId: string;
  model: { providerID: string; modelID: string; variant?: string };
}): Promise<Response | null> {
  try {
    await preferencesManager.validateQuickChatModel(body);
    return null;
  } catch (error) {
    if (isDomainError(error) && error.code === "quick_chat_model_mismatch") {
      return internalErrorResponse(
        error,
        {
          error: "quick_chat_model_mismatch",
          message: "Chat model validation failed",
          status: 400,
        },
        undefined,
        "chats",
      );
    }
    throw error;
  }
}

export const chatsCrudRoutes = defineRoutes({
  "/api/chats": {
    delegation: workspaceOperation("chat", { collection: true }),
    partialResults: { header: "X-Clanky-Partial" },
    auth: "user",
    sameOrigin: "mutations",
    description: "List chats or create a chat session.",
    requestSchema: CreateChatRequestSchema,
    operations: {
      GET: {
        description: "List chats, optionally filtered by workspace.",
        requestSchema: undefined,
        querySchema: WorkspaceFilterQuerySchema.safeExtend(WorkCollectionReadOptionsSchema.shape),
        automation: { policy: "read" },
      },
      POST: {
        description: "Create a chat; permission requests are automatically approved.",
        requestSchema: CreateChatRequestSchema,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Creates agent work with automatic permission approval." },
      },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");
      if (url.searchParams.get("view") === "compact" && url.searchParams.get("section") === "details" && url.searchParams.has("item")) {
        return Response.json(await readWorkCollectionItem({
          resource: "chat", workspaceId: workspaceId ?? undefined,
          options: WorkCollectionReadOptionsSchema.parse(Object.fromEntries(url.searchParams)),
        }));
      }
      if (url.searchParams.get("view") === "compact" && !url.searchParams.has("section") && !url.searchParams.has("item")) {
        return resourcePageResponse(readWorkCollection({
          resource: "chat", workspaceId: workspaceId ?? undefined,
          options: WorkCollectionReadOptionsSchema.parse(Object.fromEntries(url.searchParams)),
          scope: readScope(_ctx.requireUser().id, url),
        }));
      }
      const chats = workspaceId
        ? await chatManager.getChatSummariesByWorkspace(workspaceId)
        : await chatManager.getChatSummaries();
      return Response.json(chats);
    },

    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data;
      const workspace = await requireWorkspace(body.workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      if (body.quick) {
        const quickChatValidation = await validateQuickChatRequestModel(body);
        if (quickChatValidation) {
          return quickChatValidation;
        }
      }

      try {
        const chat = await chatManager.createChat({
          name: body.name,
          workspaceId: workspace.id,
          modelProviderID: body.model.providerID,
          modelID: body.model.modelID,
          modelVariant: body.model.variant,
          useWorktree: body.useWorktree,
          useSelectedBranchForWorktree: body.useSelectedBranchForWorktree,
          useChatNameAsBranch: body.useChatNameAsBranch,
          baseBranch: body.baseBranch,
          directory: body.directory,
          syncBaseBranch: !body.quick,
          prepareWorktreeOnCreate: false,
        });
        return Response.json(await toLightweightChat(chat), { status: 201 });
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to create chat", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "create_failed",
          message: "Failed to create chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id/new-here": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a fresh chat in the source chat's current workspace directory; permission requests are automatically approved.",
    operations: {
      POST: {
        requestSchema: undefined,
        querySchema: undefined,
        automation: { policy: "confirm", reason: "Creates a new chat with automatic permission approval." },
      },
    },
    async POST(_req: Request, ctx): Promise<Response> {
      const chatId = ctx.params["id"]!;
      try {
        const chat = await chatManager.createChatHere(chatId);
        return Response.json(await toLightweightChat(chat), { status: 201 });
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to create chat in current directory", {
          chatId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "create_failed",
          message: "Failed to create chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id": {
    delegation: workspaceOperation("chat"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a chat session; remote cleanup may continue after deletion.",
    requestSchema: UpdateChatRequestSchema,
    operations: {
      GET: {
        description: "Read the current chat summary and queued interactions.",
        requestSchema: undefined,
        querySchema: CollectionReadOptionsSchema,
        automation: { policy: "read" },
      },
      PATCH: {
        description: "Update a chat's name, model, branch, worktree, or privacy.",
        requestSchema: UpdateChatRequestSchema,
        querySchema: undefined,
        automation: { policy: "write" },
      },
      DELETE: {
        description: "Move a standalone chat to Trash for 30 days.",
        requestSchema: undefined,
        querySchema: undefined,
        automation: {
          policy: "confirm",
          reason: "Deletes the chat and stops its active work. Standalone chats are recoverable for 30 days; agent conversations are deleted permanently.",
        },
      },
    },
    async GET(_req: Request, ctx): Promise<Response> {
      const compact = workMetadataResponse(_req, { resource: "chat", id: ctx.params["id"]!, notFound: { code: "not_found", message: "Chat not found" } });
      if (compact) return compact;
      const chat = await chatManager.getChatSummary(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      return Response.json(chat);
    },

    async PATCH(req: Request, ctx): Promise<Response> {
      const existing = await chatManager.getChat(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      if (isTaskChat(existing)) {
        return errorResponse("task_chat_managed_by_task", "Task chats are managed from their owning task", 409);
      }

      const validation = await parseAndValidate(UpdateChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      if (validation.data.model && isWorkspaceChat(existing)) {
        const modelValidation = await isModelEnabled(
          getChatWorkspaceId(existing),
          validation.data.model.providerID,
          validation.data.model.modelID,
        );
        if (!modelValidation.enabled) {
          return errorResponse(
            modelValidation.errorCode ?? "model_not_enabled",
            modelValidation.error ?? "The selected model is not available",
          );
        }
      }

      try {
        const updated = await chatManager.updateChat(ctx.params["id"]!, mapChatUpdates(validation.data));
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(await toLightweightChat(updated));
      } catch (error) {
        const knownErrorResponse = chatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to update chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "update_failed",
          message: "Failed to update chat",
          status: 500,
        }, undefined, "chats");
      }
    },

    async DELETE(_req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      if (isTaskChat(chat)) {
        return errorResponse("task_chat_managed_by_task", "Task chats are deleted with their owning task", 409);
      }

      try {
        if (isStandaloneChat(chat)) {
          await chatManager.trashChat(ctx.params["id"]!);
        } else if (!await chatManager.deleteChat(ctx.params["id"]!)) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return successResponse();
      } catch (error) {
        log.error("Failed to delete chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "delete_failed",
          message: "Failed to delete chat",
          status: 500,
        }, undefined, "chats");
      }
    },
  },
});
