import { ChatBranchCheckoutError, ChatBusyError, ChatNotMarkableError, ChatPermissionReplyError, ChatPermissionRequestNotFoundError, EmptyChatTranscriptError, InvalidChatBaseBranchError, InvalidCurrentPlanError, SshCredentialsRequiredError, type Chat } from "@/shared/chat";
import type { Task } from "@/shared/task";
import { isAcpErrorCode, isAcpSshTransportFailure } from "../../backends/acp";
import { isDomainError } from "../../core/domain-error";
import { chatManager } from "../../core/chat-manager";
import { taskManager } from "../../core/task-manager";
import { domainErrorResponse, errorResponse } from "../helpers";

type ChatActionError = Error & {
  readonly code: string;
  readonly status: number;
};

function isChatActionError(error: unknown): error is ChatActionError {
  return error instanceof ChatBusyError
    || error instanceof EmptyChatTranscriptError
    || error instanceof InvalidCurrentPlanError
    || error instanceof InvalidChatBaseBranchError
    || error instanceof ChatBranchCheckoutError
    || error instanceof ChatNotMarkableError
    || error instanceof ChatPermissionRequestNotFoundError
    || error instanceof ChatPermissionReplyError
    || error instanceof SshCredentialsRequiredError;
}

export function chatActionErrorResponse(error: unknown): Response | null {
  if (isChatActionError(error)) {
    return errorResponse(error.code, error.message, error.status);
  }

  if (!isDomainError(error)) {
    return null;
  }

  if (error.code === "acp_connection_timed_out") {
    const isSsh = error.details["transport"] === "ssh";
    return errorResponse(
      isSsh ? "ssh_connection_timeout" : "connection_timeout",
      isSsh
        ? "The SSH connection timed out before the agent became ready"
        : "The agent connection timed out before it became ready",
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

  if (
    isAcpSshTransportFailure(error)
    && !isAcpErrorCode(error, "acp_connection_aborted")
  ) {
    return errorResponse(
      "ssh_transport_unavailable",
      "The SSH agent connection is unavailable; reconnect before sending another message",
      503,
    );
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

export async function toLightweightTask(task: Task): Promise<Task> {
  const summary = await taskManager.getTaskSummary(task.config.id);
  if (!summary) {
    throw new Error(`Task disappeared after mutation: ${task.config.id}`);
  }
  return summary;
}
