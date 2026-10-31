/**
 * Owns durable chat questions, validation and single-admission answer delivery.
 */

import type { Backend } from "../backends/types";
import type { ChatStatePort, ChatSessionPort, ChatMessageOptions } from "./chat-service-contracts";
import type { HarnessEvent } from "@/shared/harness-events";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import type { HarnessQuestionRequest } from "@/shared/harness-questions";
import { formatHarnessAnswers, isQuestionOpen } from "@/shared/harness-questions";
import { ChatBusyError, isChatBusyStatus, type Chat } from "@/shared/chat";
import { HarnessError } from "../backends/harness-errors";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";
import { requireExecutionOwnerUserId } from "../context/user-context";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue";
import { validateQuestionAnswers } from "./question-validation";
import type { MessageData } from "@/shared/events";
import { isHarnessInputValidationError } from "./harness-input-ledger";
import type { ReplyToChatQuestionRequest } from "@/contracts/api";
import type { ChatAttachmentService } from "./chat-attachment-service";

export class ChatQuestionService {
  private readonly operations = new KeyedOperationQueue();

  constructor(private readonly dependencies: {
    state: ChatStatePort;
    session: ChatSessionPort;
    attachments: ChatAttachmentService;
    hasActiveStream: (id: string) => boolean;
    sendMessage?: (chatId: string, options: ChatMessageOptions) => Promise<Chat>;
  }) {}

  handle(chatId: string, binding: HarnessConversationBinding, { event, questionMessageId }: {
    event: HarnessEvent;
    questionMessageId?: string;
  }): Promise<void> {
    return this.operations.run(chatId, async () => {
      if (event.type !== "question.asked" && event.type !== "question.resolved") return;
      const chat = await this.dependencies.state.getChatSummary(chatId);
      if (!chat?.state.session?.binding) return;
      requireMatchingHarnessBinding(JSON.stringify(chat.state.session.binding), binding);
      if (binding.ownerId !== requireExecutionOwnerUserId()) throw new HarnessError("harness_session_not_owned", "The question is not owned by this user.");
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
        secretIdentifier: event.secretIdentifier,
        status: "pending", createdAt: event.timestamp ?? new Date().toISOString(),
        transcript: {
          questionMessageId: event.responseMode === "message" && event.scope.native?.messageId
            ? questionMessageId ?? event.scope.native.messageId : `${id}-question`,
          answerMessageId: `${id}-answer`,
        },
      }]);
    });
  }

  reply(chatId: string, requestId: string, reply: ReplyToChatQuestionRequest): Promise<Chat> {
    return this.operations.run(chatId, async () => {
      const { answers, attachments = [] } = reply;
      let chat = await this.dependencies.state.getChatSummary(chatId);
      if (!chat) throw new HarnessError("harness_question_not_found", "The chat question is unavailable.");
      const request = chat.state.harness?.questions?.find((entry) => entry.requestId === requestId);
      if (!request) throw new HarnessError("harness_question_not_found", "The chat question is unavailable.");
      if (request.secretIdentifier !== undefined) {
        throw new HarnessError("harness_unsupported_feature", "Use the private secret form; secrets cannot be submitted as chat answers.");
      }
      const binding = chat.state.session?.binding;
      if (!binding || binding.ownerId !== requireExecutionOwnerUserId()) throw new HarnessError("harness_session_not_owned", "The question is not owned by this conversation.");
      requireMatchingHarnessBinding(JSON.stringify(request.conversation), binding);
      validateQuestionAnswers(request.questions, answers, attachments);
      if ((request.status === "answered" || request.status === "queued")
        && JSON.stringify(request.answers) === JSON.stringify(answers)
        && JSON.stringify(request.attachmentIds ?? request.questions.map(() => []))
          === JSON.stringify(request.questions.map((_, index) => attachments[index]?.map((image) => image.id) ?? []))) {
        const previous = request.transcript
          ? await this.dependencies.state.getChatMessage(chatId, request.transcript.answerMessageId) : null;
        if (JSON.stringify(previous?.attachments ?? []) === JSON.stringify(attachments.flat())) return chat;
      }
      if (request.status !== "pending") throw new HarnessError("harness_question_closed", "This question can no longer receive an answer.");
      const backend: Backend = this.dependencies.session.getChatBackend(chatId, chat.config.workspaceId);
      if (!backend.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect the conversation before answering.");
      const answering: HarnessQuestionRequest = {
        ...request,
        status: "submitting", answers, error: undefined,
        attachmentIds: request.questions.map((_, index) => attachments[index]?.map((image) => image.id) ?? []),
        transcript: request.transcript ? {
          ...request.transcript,
          answerTimestamp: new Date(Math.max(Date.now(), Date.parse(request.createdAt) + 1)).toISOString(),
        } : undefined,
      };
      if (attachments.flat().length && !answering.transcript) {
        throw new HarnessError("harness_unsupported_feature", "This question cannot retain image answers.");
      }
      // Persist originals and uncertain admission before any native reply.
      chat = await this.save(chat, (chat.state.harness?.questions ?? []).map((entry) => entry.requestId === requestId ? {
        ...answering,
      } : entry), answering.transcript ? {
        id: answering.transcript.answerMessageId, role: "user",
        content: formatHarnessAnswers(answering), timestamp: answering.transcript.answerTimestamp!,
        attachments: attachments.flat().length ? attachments.flat() : undefined,
      } : undefined);
      if (chat.state.harness?.questions?.find((entry) => entry.requestId === requestId)?.status !== "submitting") {
        throw new HarnessError("harness_question_closed", "This question was closed before answer delivery.");
      }
      const transcriptMessage = chat.state.messages.find((message) => message.id === request.transcript?.answerMessageId);
      const nativeAnswers = request.responseMode === "message" ? answers
        : await this.prepareCallbackAnswers({ chat, request: answering, reply, transcriptMessage });
      try {
        if (request.responseMode === "message") {
          if (!this.dependencies.sendMessage) throw new HarnessError("harness_unsupported_feature", "Asynchronous question responses are unavailable.");
          return await this.dependencies.sendMessage(chatId, {
            message: request.questions.map((question, index) => [
              question.question, answers[index]!.join(", "),
              ...(attachments[index]?.length
                ? [`Attached images for this answer: ${JSON.stringify(attachments[index]!.map((image) => image.filename))}`] : []),
            ].filter(Boolean).join("\n")).join("\n\n"),
            attachments: attachments.flat(), transcriptMessage,
            clientId: reply.clientId,
          });
        } else await backend.replyToQuestion(requestId, nativeAnswers);
      } catch (error) {
        if (request.responseMode === "message") {
          const latest = await this.requireChat(chatId);
          const status = latest.state.harness?.questions?.find((entry) => entry.requestId === requestId)?.status;
          if (status === "pending" || status === "unconfirmed" || status === "answered") throw error;
          if (error instanceof ChatBusyError || isHarnessInputValidationError(error)
            || error instanceof HarnessError && error.code === "harness_input_capacity") {
            await this.replace(latest, requestId, { status: "pending", error: undefined });
            throw error;
          }
        }
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

  replySecret(chatId: string, requestId: string, value: string | null): Promise<Chat> {
    return this.operations.run(chatId, async () => {
      const chat = await this.requireChat(chatId);
      const request = chat.state.harness?.questions?.find((entry) => entry.requestId === requestId);
      if (!request || request.secretIdentifier === undefined) {
        throw new HarnessError("harness_question_not_found", "The private secret request is unavailable.");
      }
      const binding = chat.state.session?.binding;
      if (!binding || binding.ownerId !== requireExecutionOwnerUserId()
        || binding.questionPolicy !== "interactive" || binding.secretFiles !== 1) {
        throw new HarnessError("harness_session_not_owned", "The secret request is not owned by this interactive conversation.");
      }
      requireMatchingHarnessBinding(JSON.stringify(request.conversation), binding);
      if (request.status !== "pending") throw new HarnessError("harness_question_closed", "This secret request can no longer receive input.");
      const backend = this.dependencies.session.getChatBackend(chatId, chat.config.workspaceId);
      if (!backend.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect the conversation before supplying a secret.");
      if (!backend.replyToSecret || backend.harness.capabilities.secretFiles !== 1) {
        throw new HarnessError("harness_unsupported_feature", "This execution host does not support private secret files.");
      }
      const submitting = await this.replace(chat, requestId, { status: "submitting", error: undefined });
      if (submitting.state.harness?.questions?.find((entry) => entry.requestId === requestId)?.status !== "submitting") {
        throw new HarnessError("harness_question_closed", "The secret request closed before delivery.");
      }
      try {
        await backend.replyToSecret(requestId, value);
      } catch {
        await this.replace(await this.requireChat(chatId), requestId, {
          status: "unconfirmed",
          error: "Private delivery could not be confirmed. Stop or reconnect the conversation; do not submit the value again.",
        });
        throw new HarnessError("harness_question_unconfirmed", "Private secret delivery could not be confirmed.");
      }
      return await this.replace(await this.requireChat(chatId), requestId, {
        status: value === null ? "cancelled" : "answered",
        resolvedAt: new Date().toISOString(), error: undefined,
      });
    });
  }

  private async prepareCallbackAnswers({ chat, request, reply, transcriptMessage }: {
    chat: Chat;
    request: HarnessQuestionRequest;
    reply: ReplyToChatQuestionRequest;
    transcriptMessage?: MessageData;
  }): Promise<string[][]> {
    if (!reply.attachments?.some((images) => images.length)) return reply.answers;
    try {
      if (!transcriptMessage) throw new HarnessError("harness_question_invalid", "The answer images could not be restored.");
      const prepared = await this.dependencies.attachments.prepare(chat, transcriptMessage);
      const latest = await this.requireChat(chat.config.id);
      if (!latest.state.session?.binding) throw new HarnessError("harness_question_closed", "The question conversation is no longer active.");
      requireMatchingHarnessBinding(JSON.stringify(request.conversation), latest.state.session.binding);
      if (latest.state.harness?.questions?.find((entry) => entry.requestId === request.requestId)?.status !== "submitting") {
        throw new HarnessError("harness_question_closed", "The question closed while its images were being prepared.");
      }
      let offset = 0;
      const paths = new Map(prepared.files.map((file) => [file.attachmentIndex, file.path]));
      const nativeAnswers = reply.answers.map((values, index) => {
        const references = (reply.attachments?.[index] ?? []).map((image) => {
          const path = paths.get(offset++);
          if (!path) throw new HarnessError("harness_question_invalid", "An answer image is unavailable on the execution host.");
          return `Attached image (open with your tools on the execution host):\n${JSON.stringify({ name: image.filename, path })}`;
        });
        if (!references.length) return values;
        return request.questions[index]!.multiple
          ? [...values, references.join("\n\n")]
          : [[...values, ...references].join("\n\n")];
      });
      validateQuestionAnswers(request.questions, nativeAnswers);
      return nativeAnswers;
    } catch (error) {
      await this.replace(await this.requireChat(chat.config.id), request.requestId, { status: "pending", error: undefined });
      throw error;
    }
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

  private async save(chat: Chat, questions: HarnessQuestionRequest[], answerMessage?: MessageData): Promise<Chat> {
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
        messages: answerMessage && next.some((request) =>
          request.transcript?.answerMessageId === answerMessage.id && request.status === "submitting")
          ? current.state.messages.filter((message) => message.id !== answerMessage.id).concat(answerMessage)
          : current.state.messages,
        harness: { ...current.state.harness, questions: next },
        lastActivityAt: new Date().toISOString(),
      };
    });
    this.dependencies.state.emitChatUpdated(updated);
    return updated;
  }
}
