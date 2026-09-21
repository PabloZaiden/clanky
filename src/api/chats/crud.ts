import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { chatManager } from "../../core/chat-manager";
import { isDomainError } from "../../domain/domain-error";
import { isModelEnabled } from "../../core/model-discovery";
import { preferencesManager } from "../../core/preferences-manager";
import { getChatWorkspaceId, isTaskChat, isWorkspaceChat, type ChatConfig } from "@/shared/chat";
import {
  CreateChatRequestSchema,
  ImportExistingChatRequestSchema,
  UpdateChatRequestSchema,
} from "@/contracts/schemas";
import { errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { chatActionErrorResponse, toLightweightChat } from "./helpers";

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
    auth: "user",
    sameOrigin: "mutations",
    description: "List chats or create a chat session.",
    requestSchema: CreateChatRequestSchema,
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");
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
          autoApprovePermissions: body.autoApprovePermissions,
          baseBranch: body.baseBranch,
          directory: workspace.directory,
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

  "/api/chats/importable-sessions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List chat sessions available for import.",
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId")?.trim();
      if (!workspaceId) {
        return errorResponse("workspace_required", "workspaceId is required", 400);
      }
      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      try {
        const sessions = await chatManager.listImportableSessions(workspace.id);
        return Response.json(sessions);
      } catch (error) {
        log.error("Failed to list importable chat sessions", {
          workspaceId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "list_importable_sessions_failed",
          message: "Failed to list importable chat sessions",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/import": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Import an existing chat session.",
    async POST(req: Request, _ctx): Promise<Response> {
      const validation = await parseAndValidate(ImportExistingChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      const body = validation.data;
      const workspace = await requireWorkspace(body.workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      const modelValidation = await isModelEnabled(
        workspace.id,
        body.model.providerID,
        body.model.modelID,
      );
      if (!modelValidation.enabled) {
        return errorResponse(
          modelValidation.errorCode ?? "model_not_enabled",
          modelValidation.error ?? "The selected model is not available",
        );
      }

      try {
        const chat = await chatManager.importExistingSession({
          name: body.name,
          workspaceId: workspace.id,
          modelProviderID: body.model.providerID,
          modelID: body.model.modelID,
          modelVariant: body.model.variant,
          sessionId: body.sessionId,
          cwd: body.cwd,
          autoApprovePermissions: body.autoApprovePermissions,
        });
        return Response.json(await toLightweightChat(chat), { status: 201 });
      } catch (error) {
        log.error("Failed to import chat session", {
          workspaceId: body.workspaceId,
          sessionId: body.sessionId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "import_session_failed",
          message: "Failed to import chat session",
          status: 500,
        }, undefined, "chats");
      }
    },
  },

  "/api/chats/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a chat session; remote cleanup may continue after deletion.",
    requestSchema: UpdateChatRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
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
        const deleted = await chatManager.deleteChat(ctx.params["id"]!, { deferCleanup: true });
        if (!deleted) {
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
