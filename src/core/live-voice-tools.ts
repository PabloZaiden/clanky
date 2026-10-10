/**
 * Limited domain functions for the voice session's linked chat.
 */

import { z } from "zod";
import { chatManager } from "./chat-manager";
import { DomainError, isDomainError } from "../domain/domain-error";
import type { Chat } from "@/shared";

const schemas = {
  send: z.object({ message: z.string().trim().min(1).max(30_000) }).strict(),
  steer: z.object({ inputId: z.string().min(1).max(500) }).strict(),
  get_status: z.object({}).strict(),
  answer_question: z.object({
    requestId: z.string().min(1).max(500),
    answers: z.array(z.array(z.string().max(8_000)).max(20)).min(1).max(20),
  }).strict(),
  interrupt: z.object({ confirmed: z.literal(true) }).strict(),
};

const descriptions: Record<keyof typeof schemas, string> = {
  send: "Send an instruction to the linked agent, or queue it if busy. Does not wait for task completion.",
  steer: "Inject an existing queued input into the active agent turn. Acceptance is not completion.",
  get_status: "Read authoritative agent status, queued inputs, pending questions and recent completed results.",
  answer_question: "Answer a pending agent question in the linked chat.",
  interrupt: "Stop the agent's work only after an explicit user request. This is not voice playback interruption.",
};

export const liveVoiceToolDefinitions = Object.entries(schemas).map(([name, schema]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema);
  return { type: "function", name, description: descriptions[name as keyof typeof schemas], parameters, strict: true };
});

export function publicLiveChatState(chat: Chat): Record<string, unknown> {
  return {
    status: chat.state.status,
    error: chat.state.error ? { code: chat.state.error.code, message: chat.state.error.message.slice(0, 1_000) } : null,
    queued: (chat.state.queuedMessages ?? []).slice(-10).map(({ id, content }) => ({ id, content: content.slice(0, 1_000) })),
    questions: (chat.state.harness?.questions ?? []).filter((question) => question.status === "pending").slice(-3).map((request) => ({
      requestId: request.requestId,
      questions: request.questions.slice(0, 3).map((question) => ({
        ...question, question: question.question.slice(0, 1_000),
        header: question.header.slice(0, 500),
        options: question.options.slice(0, 10).map((option) => ({ label: option.label.slice(0, 200), description: option.description.slice(0, 200) })),
      })),
    })),
    permissionsPending: (chat.state.pendingPermissionRequests ?? []).filter((request) => request.status === "pending").length,
    results: chat.state.messages.filter((message) => message.role === "assistant" && message.id !== chat.state.activeMessageId)
      .slice(-2).map((message) => ({ id: message.id, content: message.content.slice(-4_000) })),
  };
}

export async function executeLiveVoiceTool(
  scope: { chatId: string; clientId: string; canExecute?: () => boolean },
  name: string,
  rawArguments: string,
): Promise<Record<string, unknown>> {
  try {
    const chat = await chatManager.getChat(scope.chatId);
    if (!chat) throw new DomainError("chat_not_found", "The linked chat is unavailable.");
    if (scope.canExecute?.() === false) throw new DomainError("voice_live_not_found", "The Live call has ended.");
    const args: unknown = JSON.parse(rawArguments);
    switch (name) {
      case "send": {
        const { message } = schemas.send.parse(args);
        const updated = await chatManager.sendMessage(scope.chatId, { message, clientId: scope.clientId });
        return { ok: true, state: publicLiveChatState(updated), completion: "not_confirmed" };
      }
      case "steer": {
        const { inputId } = schemas.steer.parse(args);
        const result = await chatManager.steerQueuedMessage(scope.chatId, inputId);
        return { ok: true, admission: result.admission, completion: "not_confirmed" };
      }
      case "get_status":
        schemas.get_status.parse(args);
        return { ok: true, state: publicLiveChatState(chat) };
      case "answer_question": {
        const { requestId, answers } = schemas.answer_question.parse(args);
        const updated = await chatManager.replyToQuestion(scope.chatId, requestId, answers, scope.clientId);
        return { ok: true, state: publicLiveChatState(updated) };
      }
      case "interrupt":
        schemas.interrupt.parse(args);
        await chatManager.interruptChat(scope.chatId, "User requested stop through Live voice");
        return { ok: true, status: "interrupt_requested", completion: "not_confirmed" };
      default:
        throw new DomainError("harness_unsupported_feature", "This voice action is unavailable.");
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return { ok: false, code: "invalid_arguments", message: "The voice action arguments are invalid." };
    }
    if (isDomainError(error)) return { ok: false, code: error.code, message: "The chat action could not be completed. Check the chat state before retrying." };
    throw error;
  }
}
