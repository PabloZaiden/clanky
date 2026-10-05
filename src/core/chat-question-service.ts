/**
 * Owns durable chat questions, validation and single-admission answer delivery.
 */

import type { Backend } from "../backends/types";
import type { ChatStatePort, ChatSessionPort } from "./chat-service-contracts";
import type { HarnessEvent } from "@/shared/harness-events";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessQuestionRequest } from "@/shared/harness-questions";
import { isQuestionOpen } from "@/shared/harness-questions";
import { isChatBusyStatus, type Chat } from "@/shared/chat";
import { HarnessError } from "../backends/harness-errors";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { requireCurrentUserId } from "../context/user-context";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { validateQuestionAnswers } from "./question-validation";
import type { MessageData } from "@/shared/events";

export class ChatQuestionService {
  private readonly operations = new KeyedOperationQueue();

  constructor(private readonly dependencies: {
    state: ChatStatePort;
    session: ChatSessionPort;
    hasActiveStream: (id: string) => boolean;
    sendMessage?: (chatId: string, message: string, transcriptMessage?: MessageData) => Promise<Chat>;
  }) {}

  handle(chatId: string, binding: HarnessConversationBinding, event: HarnessEvent): Promise<void> {
    return this.operations.run(chatId, async () => {
      if (event.type !== "question.asked" && event.type !== "question.resolved") return;
      const chat = await this.dependencies.state.getChatSummary(chatId);
      if (!chat?.state.session?.binding) return;
      requireMatchingHarnessBinding(JSON.stringify(chat.state.session.binding), binding);
      if (binding.ownerId !== requireCurrentUserId()) throw new HarnessError("harness_session_not_owned", "The question is not owned by this user.");
      const questions = chat.state.harness?.questions ?? [];
      const existing = questions.find((request) => request.requestId === event.requestId);
      if (event.type === "question.resolved") {
        if (existing && isQuestionOpen(existing)) {
          await this.save(chat, questions.map((request) => request === existing
            ? { ...request, status: event.outcome, resolvedAt: new Date().toISOString(), error: undefined }
            : request));
        }
        return;
      }
      if (existing) {
        if (isQuestionOpen(existing) && chat.state.status !== "waiting" && !chat.state.startupStage) {
          await this.save(chat, questions);
        }
        return;
      }
      if (binding.questionPolicy === "unattended") {
        throw new HarnessError("harness_unsupported_feature", "Human input is disabled for this autonomous conversation.");
      }
      if (event.sessionId !== binding.nativeId || questions.filter(isQuestionOpen).length >= 64) {
        throw new HarnessError("harness_request_failed", "The native question is invalid or exceeds the pending interaction limit.");
      }
      const retained = questions.length >= 256
        ? questions.filter((request) => isQuestionOpen(request)).concat(questions.filter((request) => !isQuestionOpen(request)).slice(-191))
        : questions;
      const id = `chat-question-${crypto.randomUUID()}`;
      await this.save(chat, [...retained, {
        requestId: event.requestId, conversation: binding, scope: event.scope,
        questions: event.questions, blocking: event.blocking !== false,
        responseMode: event.responseMode,
        status: "pending", createdAt: event.timestamp ?? new Date().toISOString(),
        transcript: {
          questionMessageId: event.responseMode === "message" && event.scope.native?.messageId
            ? event.scope.native.messageId : `${id}-question`,
          answerMessageId: `${id}-answer`,
        },
      }]);
    });
  }

  reply(chatId: string, requestId: string, answers: string[][]): Promise<Chat> {
    return this.operations.run(chatId, async () => {
      let chat = await this.dependencies.state.getChatSummary(chatId);
      if (!chat) throw new HarnessError("harness_question_not_found", "The chat question is unavailable.");
      const request = chat.state.harness?.questions?.find((entry) => entry.requestId === requestId);
      if (!request) throw new HarnessError("harness_question_not_found", "The chat question is unavailable.");
      const binding = chat.state.session?.binding;
      if (!binding || binding.ownerId !== requireCurrentUserId()) throw new HarnessError("harness_session_not_owned", "The question is not owned by this conversation.");
      requireMatchingHarnessBinding(JSON.stringify(request.conversation), binding);
      validateQuestionAnswers(request.questions, answers);
      if (request.status === "answered" && JSON.stringify(request.answers) === JSON.stringify(answers)) return chat;
      if (request.status !== "pending") throw new HarnessError("harness_question_closed", "This question can no longer receive an answer.");
      const backend: Backend = this.dependencies.session.getChatBackend(chatId, chat.config.workspaceId);
      if (!backend.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect the conversation before answering.");
      // Persist uncertain admission first; a lost RPC must never trigger a blind resend.
      chat = await this.replace(chat, requestId, {
        status: "submitting", answers, error: undefined,
        transcript: request.transcript ? {
          ...request.transcript,
          answerTimestamp: new Date(Math.max(Date.now(), Date.parse(request.createdAt) + 1)).toISOString(),
        } : undefined,
      });
      if (chat.state.harness?.questions?.find((entry) => entry.requestId === requestId)?.status !== "submitting") {
        throw new HarnessError("harness_question_closed", "This question was closed before answer delivery.");
      }
      try {
        if (request.responseMode === "message") {
          if (!this.dependencies.sendMessage) throw new HarnessError("harness_unsupported_feature", "Asynchronous question responses are unavailable.");
          await this.dependencies.sendMessage(
            chatId,
            request.questions.map((question, index) => `${question.question}\n${answers[index]!.join(", ")}`).join("\n\n"),
            chat.state.messages.find((message) => message.id === request.transcript?.answerMessageId),
          );
        } else await backend.replyToQuestion(requestId, answers);
      } catch (error) {
        const unsupported = error instanceof HarnessError && error.code === "harness_unsupported_feature";
        await this.replace(await this.requireChat(chatId), requestId, {
          status: unsupported ? "pending" : "unconfirmed",
          error: unsupported ? error.message : "Answer delivery could not be confirmed. Do not submit it again; stop or reconnect the conversation.",
        });
        throw new HarnessError(unsupported ? "harness_unsupported_feature" : "harness_question_unconfirmed",
          unsupported ? error.message : "Native answer delivery is unconfirmed.", { cause: error });
      }
      return this.replace(await this.requireChat(chatId), requestId, {
        status: "answered", answers, resolvedAt: new Date().toISOString(), error: undefined,
      });
    });
  }

  private async requireChat(id: string): Promise<Chat> {
    const chat = await this.dependencies.state.getChatSummary(id);
    if (!chat) throw new HarnessError("harness_session_not_found", "The chat was removed during answer delivery.");
    return chat;
  }

  private replace(chat: Chat, requestId: string, updates: Partial<HarnessQuestionRequest>): Promise<Chat> {
    return this.save(chat, (chat.state.harness?.questions ?? []).map((request) =>
      request.requestId === requestId ? { ...request, ...updates } : request));
  }

  private async save(chat: Chat, questions: HarnessQuestionRequest[]): Promise<Chat> {
    // Metadata-only reads do not carry transcript counts or collections.
    const updated = await this.dependencies.state.mutateState(chat.config.id, (current) => {
      if (!current.state.session?.binding || !chat.state.session?.binding) {
        throw new HarnessError("harness_question_closed", "The question conversation is no longer active.");
      }
      requireMatchingHarnessBinding(JSON.stringify(chat.state.session.binding), current.state.session.binding);
      const next = questions.map((request) => {
        const authoritative = current.state.harness?.questions?.find((entry) => entry.requestId === request.requestId);
        return authoritative && !isQuestionOpen(authoritative) ? authoritative : request;
      });
      const waiting = next.some((request) => request.blocking && isQuestionOpen(request));
      const active = this.dependencies.hasActiveStream(chat.config.id);
      const status = waiting && active && !current.state.startupStage && isChatBusyStatus(current.state.status) ? "waiting"
        : current.state.status === "waiting" && !waiting ? active ? "streaming" : "idle"
          : current.state.status;
      return {
        ...current.state, status,
        harness: { ...current.state.harness, questions: next },
        lastActivityAt: new Date().toISOString(),
      };
    });
    this.dependencies.state.emitChatUpdated(updated);
    return updated;
  }
}
