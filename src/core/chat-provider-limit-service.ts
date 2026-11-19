import { createLogger } from "@pablozaiden/webapp/server";
import type { Chat } from "@/shared/chat";
import { getChatWorkspaceId, isStandaloneChat, isWorkspaceChat } from "@/shared/chat";
import { executionHostBindingsEqual } from "@/shared/execution-host";
import { isQuestionOpen } from "@/shared/harness-questions";
import { MAX_PROVIDER_CONTINUATION_ATTEMPTS, nextProviderContinuationAt } from "@/shared/provider-limit";
import type { ChatProviderLimit, ProviderContinuation } from "@/shared/provider-limit";
import { HarnessError } from "../backends/harness-errors";
import { requireMatchingHarnessBindings } from "../backends/harness-binding";
import { requireCollaborationActor, requireCurrentUserId, runWithCollaborationActor } from "../context/user-context";
import { withWorkspaceAccess } from "./collaboration-authority";
import type { ChatConversationPort, ChatSessionPort, ChatStatePort } from "./chat-service-contracts";

const log = createLogger("chat-provider-limit-service");
const CONTINUE_MESSAGE = "Continue the interrupted task from the current conversation and project state. Check what has already completed before taking further actions; do not blindly repeat earlier operations.";

export class ChatProviderLimitService {
  constructor(private readonly dependencies: {
    state: ChatStatePort;
    session: ChatSessionPort;
    conversation: ChatConversationPort;
  }) {}

  async recover(chatId: string, action: "continue" | "schedule" | "cancel"): Promise<Chat> {
    const chat = await this.requireChat(chatId);
    const limit = chat.state.harness?.providerLimit;
    if (action === "cancel") {
      return limit ? this.update(chatId, limit.id, (current) => ({ ...current, continuation: undefined })) : chat;
    }
    this.assertBlocked(chat);
    if (action === "continue") {
      const current = await this.update(chatId, limit!.id, (value) => ({ ...value, continuation: undefined }));
      return this.execute(current);
    }
    if (limit!.kind === "billing") {
      throw new HarnessError("harness_unsupported_feature", "Resolve the billing issue before continuing.");
    }
    if (limit!.continuation?.status === "scheduled" || limit!.continuation?.status === "attempting") return chat;
    return this.update(chatId, limit!.id, (current) => ({
      ...current,
      continuation: {
        status: "scheduled", attempts: 0,
        nextAttemptAt: nextProviderContinuationAt(current, 0),
        conversation: chat.state.session!.binding!,
        model: { ...chat.config.model },
        actor: requireCollaborationActor(),
      },
    }));
  }

  async attempt(chatId: string, interruptionId: string, recovering = false): Promise<Chat | null> {
    const chat = await this.dependencies.state.getChat(chatId);
    const limit = chat?.state.harness?.providerLimit;
    const continuation = limit?.continuation;
    if (!chat || limit?.id !== interruptionId || !continuation) return chat;
    if (recovering && continuation.status === "attempting") {
      return this.pause(chatId, interruptionId, "Continuation was interrupted. Check its delivery before continuing manually.");
    }
    if (continuation.status !== "scheduled" || !continuation.nextAttemptAt
      || Date.parse(continuation.nextAttemptAt) > Date.now()) return chat;
    try {
      return await runWithCollaborationActor(continuation.actor, async () => {
        const execute = async () => {
          this.assertBlocked(chat);
          await this.assertTarget(chat, continuation);
          if (continuation.attempts >= MAX_PROVIDER_CONTINUATION_ATTEMPTS) {
            throw new HarnessError("harness_unsupported_feature", "Automatic continuation stopped after 12 attempts.");
          }
          const current = await this.update(chatId, interruptionId, (value) => ({
            ...value, continuation: {
              ...continuation, status: "attempting", attempts: continuation.attempts + 1,
              nextAttemptAt: undefined, reason: undefined,
            },
          }));
          return this.execute(current, continuation);
        };
        if (isWorkspaceChat(chat)) return withWorkspaceAccess(getChatWorkspaceId(chat), execute);
        if (continuation.actor.kind !== "user" || continuation.actor.userId !== requireCurrentUserId()) {
          throw new HarnessError("harness_session_not_owned", "The chat owner is no longer available.");
        }
        return execute();
      });
    } catch (error) {
      log.warn("Automatic provider continuation paused", { chatId, error: String(error) });
      return this.pause(chatId, interruptionId, error instanceof Error ? error.message : String(error));
    }
  }

  private assertBlocked(chat: Chat): void {
    if (!isStandaloneChat(chat) || chat.state.status !== "blocked" || !chat.state.harness?.providerLimit) {
      throw new HarnessError("harness_session_busy", "This chat is not blocked by a provider limit.");
    }
    if (!chat.state.session?.binding) {
      throw new HarnessError("harness_session_not_found", "The saved native conversation is unavailable.");
    }
    if (chat.state.harness.integrity === "invalid"
      || chat.state.harness.inputs?.some((receipt) =>
        receipt.admission.status === "unknown" || receipt.admission.status === "accepted")
      || chat.state.queuedMessages?.length
      || chat.state.harness.questions?.some(isQuestionOpen)
      || chat.state.pendingPermissionRequests?.some((request) => request.status === "pending")
      || chat.state.harness.historyRecovery) {
      throw new HarnessError("harness_input_unresolved", "Resolve pending inputs and interactions before continuing.");
    }
  }

  private async assertTarget(chat: Chat, continuation: ProviderContinuation): Promise<void> {
    const binding = chat.state.session?.binding;
    if (!binding) throw new HarnessError("harness_session_not_found", "The saved native conversation is unavailable.");
    requireMatchingHarnessBindings(binding, continuation.conversation);
    const model = chat.config.model;
    if (model.providerID !== continuation.model.providerID || model.modelID !== continuation.model.modelID
      || model.variant !== continuation.model.variant) {
      throw new HarnessError("harness_session_not_owned", "The chat model changed. Continue manually.");
    }
    const currentHost = isWorkspaceChat(chat)
      ? (await this.dependencies.state.getWorkspace(getChatWorkspaceId(chat)))?.executionHostBinding
      : chat.config.source?.kind === "execution_host" ? chat.config.source.executionHost : undefined;
    if (!currentHost || !binding.executionHost || !executionHostBindingsEqual(currentHost, binding.executionHost)) {
      throw new HarnessError("harness_session_not_owned", "The execution host changed. Continue manually.");
    }
    if (await this.dependencies.session.getChatAdapter(chat) !== continuation.conversation.adapter) {
      throw new HarnessError("harness_session_not_owned", "The chat adapter changed. Continue manually.");
    }
  }

  private async execute(chat: Chat, authorization?: ProviderContinuation): Promise<Chat> {
    const interruptionId = chat.state.harness!.providerLimit!.id;
    const originalBinding = chat.state.session!.binding!;
    let current = await this.dependencies.session.reconnectSession(chat);
    if (current.state.harness?.providerLimit?.id !== interruptionId) {
      throw new HarnessError("harness_session_busy", "The chat changed before continuation.");
    }
    this.assertBlocked(current);
    requireMatchingHarnessBindings(current.state.session!.binding!, originalBinding);
    if (authorization) await this.assertTarget(current, authorization);
    const activity = await this.dependencies.session.getActivity(chat.config.id);
    if (activity.observation !== "available" || activity.coverage !== "native" || activity.principalProcessing
      || activity.activities.some((item) => !["completed", "failed", "stopped", "idle"].includes(item.status))) {
      throw new HarnessError("harness_session_busy", "Native execution is active or cannot be confirmed inactive. Continue manually after checking Activity.");
    }
    current = await this.requireChat(chat.config.id);
    this.assertBlocked(current);
    if (current.state.harness?.providerLimit?.id !== interruptionId) {
      throw new HarnessError("harness_session_busy", "The chat changed before continuation.");
    }
    if (authorization) {
      if (current.state.harness.providerLimit.continuation?.status !== "attempting") {
        throw new HarnessError("harness_session_busy", "Automatic continuation was cancelled.");
      }
      await this.assertTarget(current, authorization);
    }
    const inputId = `chat-provider-continue-${crypto.randomUUID()}`;
    return this.dependencies.conversation.dispatchMessage(current, {
      message: CONTINUE_MESSAGE, attachments: [],
      transcriptMessage: {
        id: inputId, role: "user", content: CONTINUE_MESSAGE, timestamp: new Date().toISOString(),
      },
    });
  }

  private async pause(chatId: string, interruptionId: string, reason: string): Promise<Chat | null> {
    const chat = await this.dependencies.state.getChat(chatId);
    if (!chat || chat.state.harness?.providerLimit?.id !== interruptionId) return chat;
    return this.update(chatId, interruptionId, (limit) => ({
      ...limit,
      continuation: limit.continuation ? {
        ...limit.continuation, status: "paused", nextAttemptAt: undefined, reason,
      } : undefined,
    }));
  }

  private async update(chatId: string, interruptionId: string, update: (limit: ChatProviderLimit) => ChatProviderLimit): Promise<Chat> {
    const chat = await this.dependencies.state.mutateState(chatId, (current) => {
      const limit = current.state.harness?.providerLimit;
      if (limit?.id !== interruptionId) throw new HarnessError("harness_session_busy", "The provider interruption changed.");
      return { ...current.state, harness: { ...current.state.harness, providerLimit: update(limit) } };
    });
    this.dependencies.state.emitChatUpdated(chat);
    return chat;
  }

  private async requireChat(chatId: string): Promise<Chat> {
    const chat = await this.dependencies.state.getChat(chatId);
    if (!chat) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
    return chat;
  }
}
