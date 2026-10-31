import { ChatBranchCheckoutError, ChatBusyError, ChatNotMarkableError, ChatPermissionReplyError, ChatPermissionRequestNotFoundError, InvalidChatBaseBranchError, type Chat } from "@/shared/chat";
import { isDomainError } from "../../domain/domain-error";
import { chatManager } from "../../core/chat-manager";
import { domainErrorResponse, errorResponse } from "../helpers";

type ChatActionError = Error & {
  readonly code: string;
  readonly status: number;
};

function isChatActionError(error: unknown): error is ChatActionError {
  return error instanceof ChatBusyError
    || error instanceof InvalidChatBaseBranchError
    || error instanceof ChatBranchCheckoutError
    || error instanceof ChatNotMarkableError
    || error instanceof ChatPermissionRequestNotFoundError
    || error instanceof ChatPermissionReplyError;
}

export function chatActionErrorResponse(error: unknown): Response | null {
  if (isChatActionError(error)) {
    return errorResponse(error.code, error.message, error.status);
  }

  if (!isDomainError(error)) {
    return null;
  }

  if (error.code === "acp_connection_timed_out") {
    return errorResponse(
      "connection_timeout",
      "The agent connection timed out before it became ready",
      504,
    );
  }

  const response = domainErrorResponse(error, {
    policy: "chats",
    fallback: {
      error: "chat_action_failed",
      message: "Chat operation failed",
      status: 500,
    },
  });
  if (response.status !== 500) {
    return response;
  }

  return response;
}

export async function toLightweightChat(chat: Chat): Promise<Chat> {
  const summary = await chatManager.getChatSummary(chat.config.id);
  if (!summary) {
    throw new Error(`Chat disappeared after mutation: ${chat.config.id}`);
  }
  return summary;
}
