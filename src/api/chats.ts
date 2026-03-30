/**
 * Chat API routes.
 *
 * Chats are long-lived ACP-backed sessions anchored to workspaces. These routes
 * expose CRUD, reconnect, interrupt, and message-send operations.
 */

import { chatManager } from "../core/chat-manager";
import { createLogger } from "../core/logger";
import type { ChatConfig } from "../types/chat";
import {
  CreateChatRequestSchema,
  InterruptChatRequestSchema,
  SendChatMessageRequestSchema,
  UpdateChatRequestSchema,
} from "../types/schemas";
import { requireWorkspace, errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { isModelEnabled } from "./models";

const log = createLogger("api:chats");

function mapChatUpdates(body: Partial<ChatConfig>): Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode">> {
  const updates: Partial<Omit<ChatConfig, "id" | "createdAt" | "workspaceId" | "mode">> = {};

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

  return updates;
}

export const chatsRoutes = {
  "/api/chats": {
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");
      const chats = workspaceId
        ? await chatManager.getChatsByWorkspace(workspaceId)
        : await chatManager.getAllChats();
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

      const modelValidation = await isModelEnabled(
        workspace.id,
        workspace.directory,
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
        const chat = await chatManager.createChat({
          name: body.name,
          workspaceId: workspace.id,
          modelProviderID: body.model.providerID,
          modelID: body.model.modelID,
          modelVariant: body.model.variant,
          useWorktree: body.useWorktree,
          baseBranch: body.baseBranch,
          directory: workspace.directory,
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

      const validation = await parseAndValidate(UpdateChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      if (validation.data.model) {
        const modelValidation = await isModelEnabled(
          existing.config.workspaceId,
          existing.config.directory,
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
        const chat = await chatManager.sendMessage(req.params.id, {
          message: validation.data.message,
          attachments: validation.data.attachments,
        });
        return Response.json(chat);
      } catch (error) {
        const message = String(error);
        if (message === "Chat is busy") {
          return errorResponse("chat_busy", message, 409);
        }
        log.error("Failed to send chat message", { chatId: req.params.id, error: message });
        return errorResponse("send_failed", message, 500);
      }
    },
  },

  "/api/chats/:id/interrupt": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const existing = await chatManager.getChat(req.params.id);
      if (!existing) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      const validation = await parseAndValidate(InterruptChatRequestSchema, req, {
        allowEmptyBody: true,
        emptyBodyValue: {},
      });
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

  "/api/chats/:id/reconnect": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const chat = await chatManager.getChat(req.params.id);
      if (!chat) {
        return errorResponse("not_found", "Chat not found", 404);
      }

      try {
        const reconnected = await chatManager.reconnectSession(req.params.id);
        if (!reconnected) {
          return errorResponse("not_found", "Chat not found", 404);
        }
        return Response.json(reconnected);
      } catch (error) {
        log.error("Failed to reconnect chat", { chatId: req.params.id, error: String(error) });
        return errorResponse("reconnect_failed", String(error), 500);
      }
    },
  },
};
