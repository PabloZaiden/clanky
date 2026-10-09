import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import {
  AcknowledgeControlUiActionSchema,
  RequestControlUiActionSchema,
} from "@/contracts/schemas/clanky-control";
import { chatManager } from "../core/chat-manager";
import { controlUiActionService } from "../core/control-ui-action-service";
import { preferencesManager } from "../core/preferences-manager";
import { DomainError } from "../domain/domain-error";
import type { ControlUiActionOutcome } from "@/shared/clanky-control";
import { getChatWorkspaceId } from "@/shared/chat";
import { isClankyControlChat } from "@/shared/clanky-control";
import { errorResponse, internalErrorResponse, requireWorkspace, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const log = createLogger("api:control-ui-actions");

function getActionFailureStatus(
  code: Extract<ControlUiActionOutcome, { status: "failed" }>["code"],
): number {
  switch (code) {
    case "workspace_unavailable":
      return 404;
    case "editor_dirty":
    case "navigation_failed":
      return 409;
    case "file_open_failed":
    case "file_not_loaded":
      return 422;
    case "control_action_timeout":
      return 504;
    case "control_action_busy":
      return 429;
  }
}

export const controlUiActionRoutes = defineRoutes({
  "/api/control/ui-actions": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Request a transient UI action in the browser tab that originated a control-chat turn.",
    tags: ["control"],
    cliPath: "control/ui-actions",
    requestSchema: RequestControlUiActionSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(RequestControlUiActionSchema, req);
      if (!validation.success) return validation.response;

      const { chatId, clientId, turnId, action } = validation.data;
      try {
        const chat = await chatManager.getChat(chatId);
        if (!chat) {
          return errorResponse("not_found", "Chat not found.", 404);
        }
        const quickChatSettings = await preferencesManager.getQuickChatSettings();
        if (!isClankyControlChat(chat, quickChatSettings.workspaceId)) {
          return errorResponse("control_chat_required", "This chat is not configured for Clanky control.", 403);
        }

        if (action.type === "open_workspace" || action.type === "open_workspace_file") {
          const workspace = await requireWorkspace(action.workspaceId);
          if (workspace instanceof Response) return workspace;
        } else {
          const targetChat = await chatManager.getChat(action.chatId);
          if (!targetChat) {
            return errorResponse("not_found", "Chat not found.", 404);
          }
        }

        const dispatched = await controlUiActionService.dispatch({
          ownerId: ctx.requireUser().id,
          chatId,
          workspaceId: getChatWorkspaceId(chat),
          clientId,
          turnId,
          action,
        }, req.signal);
        if (dispatched.outcome.status === "failed") {
          log.warn("Control UI action was not applied", {
            actionId: dispatched.actionId,
            chatId,
            clientId,
            code: dispatched.outcome.code,
          });
          return errorResponse(
            dispatched.outcome.code,
            dispatched.outcome.message,
            getActionFailureStatus(dispatched.outcome.code),
          );
        }
        return successResponse(dispatched);
      } catch (error) {
        log[error instanceof DomainError ? "warn" : "error"](
          "Control UI action request failed",
          { action: action.type, chatId, clientId, error: String(error) },
        );
        return internalErrorResponse(error, {
          error: "control_action_failed",
          message: "The Clanky UI action could not be completed.",
          status: 500,
        }, undefined, "authenticated");
      }
    },
  },
  "/api/control/ui-actions/:actionId/ack": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Acknowledge a transient UI action from its originating browser tab.",
    tags: ["control"],
    cliPath: "control/ui-actions/:actionId/ack",
    requestSchema: AcknowledgeControlUiActionSchema,
    async POST(req: Request, ctx): Promise<Response> {
      const validation = await parseAndValidate(AcknowledgeControlUiActionSchema, req);
      if (!validation.success) return validation.response;
      try {
        controlUiActionService.acknowledge(
          ctx.requireUser().id,
          ctx.params["actionId"]!,
          validation.data,
        );
        return successResponse({ accepted: true });
      } catch (error) {
        log[error instanceof DomainError ? "warn" : "error"](
          "Control UI action acknowledgement failed",
          { actionId: ctx.params["actionId"], error: String(error) },
        );
        return internalErrorResponse(error, {
          error: "control_action_ack_failed",
          message: "The Clanky UI action acknowledgement was not accepted.",
          status: 500,
        }, undefined, "authenticated");
      }
    },
  },
});
