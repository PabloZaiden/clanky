import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Chat API routes.
 *
 * Chats are long-lived ACP-backed sessions anchored to workspaces. These routes
 * expose CRUD, reconnect, interrupt, and message-send operations.
 */

import { chatManager } from "../core/chat-manager";
import { createLogger } from "@pablozaiden/webapp/server";
import { ChatBranchCheckoutError, ChatBusyError, ChatPermissionReplyError, ChatPermissionRequestNotFoundError, EmptyChatTranscriptError, InvalidChatBaseBranchError, InvalidCurrentPlanError, SshCredentialsRequiredError, isTaskChat } from "@/shared/chat";
import type { ChatConfig } from "@/shared/chat";
import { CreateChatRequestSchema, ImportExistingChatRequestSchema, InterruptChatRequestSchema, ReconnectChatRequestSchema, ReplyToChatPermissionRequestSchema, SendChatMessageRequestSchema, SpawnCurrentPlanTaskRequestSchema, UpdateChatRequestSchema } from "@/contracts/schemas";
import { requireWorkspace, errorResponse, internalErrorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { isModelEnabled } from "../core/model-discovery";
import { isDomainError } from "../core/domain-error";
import { preferencesManager } from "../core/preferences-manager";
import { buildChatTranscriptMarkdown } from "../lib/chat-transcript-export";

const log = createLogger("api:chats");

function createChatActionErrorResponse(error: unknown): Response | null {
  if (
    error instanceof ChatBusyError
    || error instanceof EmptyChatTranscriptError
    || error instanceof InvalidCurrentPlanError
    || error instanceof InvalidChatBaseBranchError
    || error instanceof ChatBranchCheckoutError
    || error instanceof ChatPermissionRequestNotFoundError
    || error instanceof ChatPermissionReplyError
    || error instanceof SshCredentialsRequiredError
  ) {
    return errorResponse(error.code, error.message, error.status);
  }
  if (isDomainError(error)) {
    const mappings = {
      acp_request_cancelled: {
        error: "cancelled",
        message: "Chat operation was cancelled",
        status: 409,
      },
      acp_session_not_found: {
        error: "session_not_found",
        message: "The chat session is no longer available",
        status: 409,
      },
      acp_ssh_authentication_failed: {
        error: "ssh_authentication_failed",
        message: "SSH authentication failed",
        status: 401,
      },
      acp_unsupported_prompt_capability: {
        error: "unsupported_prompt_capability",
        message: "The connected agent does not support embedded document attachments",
        status: 422,
      },
    } as const;
    const mapping = mappings[error.code as keyof typeof mappings];
    if (mapping) {
      return errorResponse(mapping.error, mapping.message, mapping.status);
    }
  }
  return null;
}

function mapChatUpdates(body: Partial<ChatConfig>): Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode" | "scope" | "taskId">> {
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
      return errorResponse(error.code, error.message, 400);
    }
    throw error;
  }
}

export const chatsRoutes = defineRoutes({
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
          prepareWorktreeOnCreate: !body.quick,
        });
        return Response.json(chat, { status: 201 });
      } catch (error) {
        log.error("Failed to create chat", {
          workspaceId: body.workspaceId,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "create_failed",
          message: "Failed to create chat",
          status: 500,
        });
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
        });
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
        return Response.json(chat, { status: 201 });
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
        });
      }
    },
  },

  "/api/chats/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, update, or delete a chat session.",
    requestSchema: UpdateChatRequestSchema,
    async GET(_req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
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

      if (validation.data.model) {
        const modelValidation = await isModelEnabled(
          existing.config.workspaceId,
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
        return Response.json(updated);
      } catch (error) {
        log.error("Failed to update chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "update_failed",
          message: "Failed to update chat",
          status: 500,
        });
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
        await chatManager.deleteChat(ctx.params["id"]!);
        return successResponse();
      } catch (error) {
        log.error("Failed to delete chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "delete_failed",
          message: "Failed to delete chat",
          status: 500,
        });
      }
    },
  },

  "/api/chats/:id/messages": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Send a message to a chat session.",
    requestSchema: SendChatMessageRequestSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const existing = await chatManager.getChat(ctx.params["id"]!);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(SendChatMessageRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        await chatManager.sendMessage(ctx.params["id"]!, {
          message: validation.data.message ?? undefined,
          attachments: validation.data.attachments,
        });
        return successResponse({ chatId: ctx.params["id"]! });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = String(error);
        log.error("Failed to send chat message", { chatId: ctx.params["id"]!, error: message });
        return internalErrorResponse(error, {
          error: "send_failed",
          message: "Failed to send chat message",
          status: 500,
        });
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
        return Response.json(updated);
      } catch (error) {
        const message = String(error);
        log.error("Failed to remove queued chat message", {
          chatId: ctx.params["id"]!,
          messageId: ctx.params["messageId"]!,
          error: message,
        });
        return internalErrorResponse(error, {
          error: "remove_queued_message_failed",
          message: "Failed to remove queued chat message",
          status: 500,
        });
      }
    },
  },

  "/api/chats/:id/transcript.md": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Download a chat transcript as Markdown.",
    async GET(req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const transcript = buildChatTranscriptMarkdown(chat);
      if (!transcript) {
        return errorResponse("empty_transcript", "Chat transcript is empty. Send at least one message before exporting.", 400);
      }

      const url = new URL(req.url);
      const headers = new Headers({
        "Content-Type": "text/markdown; charset=utf-8",
      });
      if (url.searchParams.get("download") === "1") {
        headers.set("Content-Disposition", `attachment; filename="${transcript.filename}"`);
      }

      return new Response(transcript.markdown, { headers });
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
        return Response.json(updated);
      } catch (error) {
        log.error("Failed to interrupt chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "interrupt_failed",
          message: "Failed to interrupt chat",
          status: 500,
        });
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
        return Response.json(updated);
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
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
        });
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
        return Response.json(reconnected);
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        log.error("Failed to reconnect chat", { chatId: ctx.params["id"]!, error: String(error) });
        return internalErrorResponse(error, {
          error: "reconnect_failed",
          message: "Failed to reconnect chat",
          status: 500,
        });
      }
    },
  },

  "/api/chats/:id/spawn-task": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a task from an existing chat transcript.",
    async POST(_req: Request, ctx): Promise<Response> {
      const chat = await chatManager.getChat(ctx.params["id"]!);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const workspace = await requireWorkspace(chat.config.workspaceId);
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
        return Response.json(task, { status: 201 });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to spawn task from chat", { chatId: ctx.params["id"]!, error: message });
        return internalErrorResponse(error, {
          error: "spawn_failed",
          message: "Failed to create a task from the chat",
          status: 500,
        });
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

      const workspace = await requireWorkspace(chat.config.workspaceId);
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
        return Response.json(task, { status: 201 });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to spawn task from current plan", { chatId: ctx.params["id"]!, error: message });
        return internalErrorResponse(error, {
          error: "spawn_failed",
          message: "Failed to create a task from the current chat plan",
          status: 500,
        });
      }
    },
  },
});
