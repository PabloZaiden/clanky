/**
 * Chat API routes.
 *
 * Chats are long-lived ACP-backed sessions anchored to workspaces. These routes
 * expose CRUD, reconnect, interrupt, and message-send operations.
 */

import { chatManager } from "../core/chat-manager";
import { createLogger } from "../core/logger";
import {
  ChatBranchCheckoutError,
  ChatBusyError,
  ChatPermissionReplyError,
  ChatPermissionRequestNotFoundError,
  EmptyChatTranscriptError,
  InvalidChatBaseBranchError,
  InvalidCurrentPlanError,
  SshCredentialsRequiredError,
  isTaskChat,
} from "../types/chat";
import type { ChatConfig } from "../types/chat";
import {
  CreateChatRequestSchema,
  ImportExistingChatRequestSchema,
  InterruptChatRequestSchema,
  ReconnectChatRequestSchema,
  ReplyToChatPermissionRequestSchema,
  SendChatMessageRequestSchema,
  SpawnCurrentPlanTaskRequestSchema,
  UpdateChatRequestSchema,
} from "../types/schemas";
import { requireWorkspace, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { isModelEnabled } from "./models";
import { getQuickChatSettings } from "../persistence/preferences";
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
  const quickChatSettings = await getQuickChatSettings();
  const configuredModel = quickChatSettings.model;
  if (
    quickChatSettings.workspaceId !== body.workspaceId
    || !configuredModel
    || configuredModel.providerID !== body.model.providerID
    || configuredModel.modelID !== body.model.modelID
    || configuredModel.variant !== (body.model.variant ?? "")
  ) {
    return errorResponse(
      "quick_chat_model_mismatch",
      "Quick chat requests must use the saved quick chat workspace and model settings",
      400,
    );
  }
  return null;
}

export const chatsRoutes = {
  "/api/chats": {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");
      const chats = workspaceId
        ? await chatManager.getChatSummariesByWorkspace(workspaceId)
        : await chatManager.getChatSummaries();
      return Response.json(chats);
    },

    async POST(req: Request): Promise<Response> {
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
        return errorResponse("create_failed", String(error), 500);
      }
    },
  },

  "/api/chats/importable-sessions": {
    async GET(req: Request): Promise<Response> {
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
        return errorResponse("list_importable_sessions_failed", String(error), 500);
      }
    },
  },

  "/api/chats/import": {
    async POST(req: Request): Promise<Response> {
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
        return errorResponse("import_session_failed", String(error), 500);
      }
    },
  },

  "/api/chats/:id": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      return Response.json(chat);
    },

    async PATCH(req: Request & { params: { id: string } }): Promise<Response> {
      const existing = await chatManager.getChat(req.params.id);
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
        const updated = await chatManager.updateChat(req.params.id, mapChatUpdates(validation.data));
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(updated);
      } catch (error) {
        log.error("Failed to update chat", { chatId: req.params.id, error: String(error) });
        return errorResponse("update_failed", String(error), 500);
      }
    },

    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }
      if (isTaskChat(chat)) {
        return errorResponse("task_chat_managed_by_task", "Task chats are deleted with their owning task", 409);
      }

      try {
        await chatManager.deleteChat(req.params.id);
        return successResponse();
      } catch (error) {
        log.error("Failed to delete chat", { chatId: req.params.id, error: String(error) });
        return errorResponse("delete_failed", String(error), 500);
      }
    },
  },

  "/api/chats/:id/messages": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const existing = await chatManager.getChat(req.params.id);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(SendChatMessageRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        await chatManager.sendMessage(req.params.id, {
          message: validation.data.message ?? undefined,
          attachments: validation.data.attachments,
        });
        return successResponse({ chatId: req.params.id });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = String(error);
        log.error("Failed to send chat message", { chatId: req.params.id, error: message });
        return errorResponse("send_failed", message, 500);
      }
    },
  },

  "/api/chats/:id/queued-messages/:messageId": {
    async DELETE(req: Request & { params: { id: string; messageId: string } }): Promise<Response> {
      try {
        const updated = await chatManager.removeQueuedMessage(req.params.id, req.params.messageId);
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(updated);
      } catch (error) {
        const message = String(error);
        log.error("Failed to remove queued chat message", {
          chatId: req.params.id,
          messageId: req.params.messageId,
          error: message,
        });
        return errorResponse("remove_queued_message_failed", message, 500);
      }
    },
  },

  "/api/chats/:id/transcript.md": {
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
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
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const existing = await chatManager.getChat(req.params.id);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(InterruptChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const updated = await chatManager.interruptChat(req.params.id, validation.data.reason);
        if (!updated) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(updated);
      } catch (error) {
        log.error("Failed to interrupt chat", { chatId: req.params.id, error: String(error) });
        return errorResponse("interrupt_failed", String(error), 500);
      }
    },
  },

  "/api/chats/:id/permissions/:requestId": {
    async POST(req: Request & { params: { id: string; requestId: string } }): Promise<Response> {
      const existing = await chatManager.getChat(req.params.id);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(ReplyToChatPermissionRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const updated = await chatManager.replyToPermission(
          req.params.id,
          req.params.requestId,
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
          chatId: req.params.id,
          requestId: req.params.requestId,
          error: String(error),
        });
        return errorResponse("permission_reply_failed", String(error), 500);
      }
    },
  },

  "/api/chats/:id/reconnect": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      try {
        const validation = await parseAndValidate(ReconnectChatRequestSchema, req, { allowEmptyBody: true });
        if (!validation.success) {
          return validation.response;
        }
        const reconnected = await chatManager.reconnectSession(req.params.id, {
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
        log.error("Failed to reconnect chat", { chatId: req.params.id, error: String(error) });
        return errorResponse("reconnect_failed", String(error), 500);
      }
    },
  },

  "/api/chats/:id/spawn-task": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
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
        const task = await chatManager.spawnTaskFromChat(req.params.id);
        return Response.json(task, { status: 201 });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to spawn task from chat", { chatId: req.params.id, error: message });
        return errorResponse("spawn_failed", message, 500);
      }
    },
  },

  "/api/chats/:id/spawn-task-from-current-plan": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const validation = await parseAndValidate(SpawnCurrentPlanTaskRequestSchema, req, {
        allowEmptyBody: true,
      });
      if (!validation.success) {
        return validation.response;
      }

      const chat = await chatManager.getChat(req.params.id);
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
        const task = await chatManager.spawnTaskFromCurrentPlan(req.params.id, validation.data.planFilePath);
        return Response.json(task, { status: 201 });
      } catch (error) {
        const knownErrorResponse = createChatActionErrorResponse(error);
        if (knownErrorResponse) {
          return knownErrorResponse;
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to spawn task from current plan", { chatId: req.params.id, error: message });
        return errorResponse("spawn_failed", message, 500);
      }
    },
  },
};
