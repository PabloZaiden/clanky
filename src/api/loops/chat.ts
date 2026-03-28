/**
 * Chat routes for interactive chat sessions.
 *
 * Chats are loops with `mode: "chat"` — they share the same DB, state machine,
 * and post-completion actions (push, merge, accept, discard). The difference is
 * in how they execute: single-turn, user-driven message injection instead of
 * autonomous multi-iteration loops.
 *
 * - POST /api/loops/chat - Create a new interactive chat
 * - POST /api/loops/:id/chat - Send a message to an existing chat
 */

import { loopManager } from "../../core/loop-manager";
import { backendManager } from "../../core/backend-manager";
import { GitService } from "../../core/git-service";
import { getWorkspace, touchWorkspace } from "../../persistence/workspaces";
import { createLogger } from "../../core/logger";
import { isModelEnabled } from "../models";
import type { SendChatMessageResponse } from "../../types/api";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import { CreateChatRequestSchema, SendChatMessageRequestSchema } from "../../types/schemas";
import { validateEnabledModelForLoop, startErrorResponse } from "./helpers";

const log = createLogger("api:loops");

export const loopsChatRoutes = {
  "/api/loops/chat": {
    /**
     * POST /api/loops/chat - Create a new interactive chat.
     *
     * Creates a chat (loop with mode "chat") and starts it immediately.
     * The chat is ready to receive messages via POST /api/loops/:id/chat.
     *
     * Request Body Fields:
     * - workspaceId (required): Workspace to create the chat in
     * - prompt (required): Initial message to send to the AI
     * - model: { providerID, modelID, variant } for AI model selection
     * - baseBranch: Base branch to create chat from
     * - git: { branchPrefix, commitScope } for git integration
     *
     * Errors:
     * - 400: Validation error or invalid JSON body
     * - 404: Workspace not found
     * - 500: Chat created but failed to start
     *
     * @returns Created Loop object (with mode "chat") with 201 status
     */
    async POST(req: Request): Promise<Response> {
      log.debug("POST /api/loops/chat - Creating new chat");

      // Parse and validate request body
      const validation = await parseAndValidate(CreateChatRequestSchema, req);
      if (!validation.success) {
        log.debug("POST /api/loops/chat - Validation failed");
        return validation.response;
      }
      const body = validation.data;

      // Resolve workspace
      const workspace = await getWorkspace(body.workspaceId);
      if (!workspace) {
        return errorResponse("workspace_not_found", `Workspace not found: ${body.workspaceId}`, 404);
      }
      const directory = workspace.directory;
      const workspaceId = body.workspaceId;

      // Touch workspace to update last used timestamp
      await touchWorkspace(workspace.id);

      // Validate model is enabled if provided
      if (body.model?.providerID && body.model?.modelID) {
        const modelValidation = await isModelEnabled(
          workspaceId,
          directory,
          body.model.providerID,
          body.model.modelID,
        );
        if (!modelValidation.enabled) {
          return errorResponse(
            modelValidation.errorCode ?? "model_not_enabled",
            modelValidation.error ?? "The selected model is not available",
          );
        }
      }

      // Auto-detect default branch if baseBranch not provided
      let effectiveBaseBranch = body.baseBranch;
      if (!effectiveBaseBranch) {
        try {
          const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory);
          const git = GitService.withExecutor(executor);
          effectiveBaseBranch = await git.getDefaultBranch(directory);
          log.debug(`Auto-detected default branch for chat: ${effectiveBaseBranch}`);
        } catch (error) {
          log.warn(`Failed to detect default branch for chat, will fall back to current branch: ${String(error)}`);
        }
      }

      try {
        const chat = await loopManager.createChat({
          directory,
          prompt: body.prompt,
          attachments: body.attachments,
          workspaceId,
          modelProviderID: body.model?.providerID,
          modelID: body.model?.modelID,
          modelVariant: body.model?.variant,
          gitBranchPrefix: body.git?.branchPrefix,
          gitCommitScope: body.git?.commitScope,
          baseBranch: effectiveBaseBranch,
          useWorktree: body.useWorktree,
        });

        // Save the model as last used if provided
        if (body.model?.providerID && body.model?.modelID) {
          await loopManager.saveLastUsedModel({
            providerID: body.model.providerID,
            modelID: body.model.modelID,
            variant: body.model.variant,
          });
        }

        return Response.json(chat, { status: 201 });
      } catch (error) {
        return startErrorResponse(error, "create_chat_failed", "Failed to create chat", {
          workspaceId,
          directory,
        });
      }
    },
  },

  "/api/loops/:id/chat": {
    /**
     * POST /api/loops/:id/chat - Send a message to an interactive chat.
     *
     * Injects a user message into the chat. If the AI is currently responding,
     * the active ACP turn is stopped first and the new message is applied in
     * the next chat turn. If the AI is idle (previous turn completed), a new
     * single-turn iteration is started immediately.
     *
     * Returns immediately after setting up the injection — does not wait for
     * the AI to finish responding.
     *
     * Request Body:
     * - message (required): The user's message
     * - model (optional): { providerID, modelID, variant } to override model for this turn
     *
     * Errors:
     * - 400: Validation error, not a chat, or invalid state
     * - 404: Loop not found
     * - 500: Internal error
     *
     * @returns SendChatMessageResponse with success and loopId
     */
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      log.debug("POST /api/loops/:id/chat - Sending chat message", { loopId: req.params.id });

      // Parse and validate request body
      const validation = await parseAndValidate(SendChatMessageRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const body = validation.data;

      // Validate model is enabled if provided
      if (body.model?.providerID && body.model?.modelID) {
        const modelError = await validateEnabledModelForLoop(req.params.id, body.model);
        if (modelError) {
          return modelError;
        }
      }

      try {
        await loopManager.sendChatMessage(
          req.params.id,
          body.message,
          body.model ? {
            providerID: body.model.providerID,
            modelID: body.model.modelID,
            variant: body.model.variant,
          } : undefined,
          body.attachments,
        );

        const response: SendChatMessageResponse = {
          success: true,
          loopId: req.params.id,
        };
        return Response.json(response);
      } catch (error) {
        const errorMsg = String(error);
        if (errorMsg.includes("not found")) {
          return errorResponse("not_found", errorMsg, 404);
        }
        if (errorMsg.includes("not a chat")) {
          return errorResponse("not_chat", errorMsg, 400);
        }
        if (errorMsg.includes("Cannot send chat message")) {
          return errorResponse("invalid_state", errorMsg, 400);
        }
        log.error("Failed to send chat message", {
          loopId: req.params.id,
          error: errorMsg,
        });
        return errorResponse("send_chat_message_failed", errorMsg, 500);
      }
    },
  },
};
