import { createLogger } from "@pablozaiden/webapp/server";
import type { ControlAccess } from "./control-session-service";
import { requireControlChat } from "./control-origin";
import { runWithAuthenticatedUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { chatManager } from "./chat-manager";
import {
  createInterruptibleOperationCoordinator,
  INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
} from "./interruptible-operation";

const log = createLogger("core:deterministic-agent-prompt");

export async function promptDeterministicAgent(
  access: ControlAccess, chatId: string, message: string, signal: AbortSignal,
): Promise<string> {
  if (typeof message !== "string" || message.length === 0) {
    throw new DomainError("control_request_invalid", "A workspace prompt message is required.");
  }
  signal.throwIfAborted();
  const grant = await access.revalidate();
  return await runWithAuthenticatedUser(grant.user, async () => {
    await requireControlChat(grant, chatId);
    const chat = await chatManager.getChat(chatId);
    if (!chat) throw new DomainError("control_context_unavailable", "The execution's conversation is unavailable.");
    const previousMessageIds = new Set(chat.state.messages.map((candidate) => candidate.id));
    const coordinator = createInterruptibleOperationCoordinator({
      signal,
      interrupt: async () => { await chatManager.interruptChat(chatId, "Workspace prompt was cancelled"); },
      settlementTimeoutMs: INTERRUPTIBLE_OPERATION_SETTLE_TIMEOUT_MS,
      createAbortError: () => new DomainError("control_cancelled", "Workspace prompt was cancelled."),
      onInterruptError: (error, phase) => {
        log.error("Failed to interrupt workspace prompt", { chatId, phase, error: String(error) });
      },
      onSettlementTimeout: (phase) => {
        log.warn("Workspace prompt did not settle after cancellation", { chatId, phase });
      },
    });
    try {
      signal.throwIfAborted();
      const sent = await coordinator.runPhase(
        () => chatManager.sendMessage(chatId, { message }), "send",
      );
      const sentUserMessage = sent.state.messages.findLast((candidate) =>
        candidate.role === "user" && !previousMessageIds.has(candidate.id) && candidate.content === message,
      );
      const completed = await coordinator.runPhase(
        () => chatManager.waitForChatIdle(chatId), "wait", { allowLateInterrupt: false },
      );
      if (completed.state.status === "failed" || completed.state.error) {
        throw new DomainError("agent_prompt_failed", completed.state.error?.message ?? "Workspace prompt failed.");
      }
      const response = completed.state.messages.findLast((candidate) =>
        candidate.role === "assistant" && candidate.content.trim().length > 0
        && !previousMessageIds.has(candidate.id)
        && (!sentUserMessage || candidate.timestamp >= sentUserMessage.timestamp),
      );
      if (!response) throw new DomainError("agent_prompt_failed", "The conversation completed without an assistant response.");
      return response.content;
    } catch (error) {
      if (signal.aborted) throw new DomainError("control_cancelled", "Workspace prompt was cancelled.", { cause: error });
      log.error("Workspace prompt failed", { chatId, error: String(error) });
      throw error;
    } finally {
      await coordinator.dispose();
    }
  });
}
