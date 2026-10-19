/**
 * Harness prompt execution and persisted conversation materialization.
 */

import {
  getAcpErrorMessage,
  isAcpErrorCode,
  isAcpSshTransportFailure,
  isAcpSshTransportFailureMetadata,
} from "../backends/acp";
import type {
  Backend,
  PromptInput,
} from "../backends/types";
import type { HarnessEvent as AgentEvent } from "@/shared/harness-events";
import type {
  Chat,
  ChatConfig,
  ChatPermissionRequest,
  ChatState,
  ChatStatus,
  MessageData,
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
  TaskLogEntry,
  TranscriptChangeSet,
} from "@/shared";
import { createTranscriptChangeSet } from "@/shared";
import { getMessageAttachmentByteLength } from "@/shared/message-attachments";
import {
  ChatBusyError,
  getChatWorkspaceId,
  isChatBusyStatus,
  isExecutionHostChat,
  isStandaloneChat,
  isWorkspaceChat,
} from "@/shared/chat";
import type { ChatEvent } from "@/shared/events";
import { createTimestamp } from "@/shared/events";
import {
  AgentStreamCheckpointPolicy,
  AgentStreamController,
  type AgentStreamEventResult,
  type AgentStreamHandle,
} from "./agent-stream-controller";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { TranscriptMemoryIndex } from "./transcript-memory-index";
import { StreamVersion } from "./stream-version";
import type { LiveTranscriptState } from "./transcript-stream-projection";
import {
  AgentEventTranscriptInterpreter,
  type AgentEventTranscriptBlock,
} from "./agent-event-transcript-interpreter";
import { createLogger } from "@pablozaiden/webapp/server";
import { resolveEffectiveCheapModel } from "./cheap-model";
import { DEFAULT_CHAT_NAME_TIMEOUT_MS, generateChatName } from "../utils/name-generator";
import { resolveToolCallImagePreview, getImageViewToolPath } from "./tool-call-image-preview";
import { mergeToolCallRecord, upsertToolCallExtra, type ToolCallExtra } from "@/shared/tool-call";
import { isPersistenceError } from "../persistence/errors";
import { isGeneratedChatName } from "./chat-name";
import type {
  ChatDirectoryResolution,
  ChatConversationPort,
  ChatSessionPort,
  ChatStatePort,
  ChatWorktreePort,
  NormalizedChatMessageInput,
} from "./chat-service-contracts";
import {
  ChatHistoryExportService,
  type ChatHistoryPromptContext,
} from "./chat-history-export-service";
import { buildPromptParts } from "../backends/prompt-parts";
import type { ChatAttachmentService } from "./chat-attachment-service";
import { createChatLatencyTimer } from "./chat-latency-instrumentation";
import { createIdempotentAsyncOperation } from "../utils/async-operation";
import { DEFAULT_ACTIVITY_TIMEOUT_SECONDS } from "@/shared/task";
import type { QueuedChatMessage } from "@/shared/chat";
import type { HarnessInputAdmission } from "@/shared/harness-control";
import { isHarnessInputValidationError, retainHarnessInputReceipt } from "./harness-input-ledger";
import { createTransientHarnessSession, cleanupTransientHarnessSession } from "./harness-session";
import { HarnessError } from "../backends/harness-errors";
import { isDomainError } from "../domain/domain-error";
import { closeOpenQuestions, isQuestionOpen, updateQuestionAnswerStatus } from "@/shared/harness-questions";
import { projectQuestionMessages } from "@/shared/question-transcript";
import { NativeChatObserver } from "./native-chat-observer";
import type { HarnessConversationBinding } from "@/shared/harness-control";
import { requireMatchingHarnessBinding } from "../backends/harness-binding";

const log = createLogger("chat-conversation-service");
const DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS = DEFAULT_ACTIVITY_TIMEOUT_SECONDS * 1000;
const DEFAULT_CHAT_IDLE_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const CHAT_STREAM_STATUS_RELOAD_INTERVAL_MS = 500;
const CHAT_INTERRUPT_ABORT_TIMEOUT_MS = 5_000;
const CHAT_INTERRUPT_STARTUP_SETTLE_TIMEOUT_MS = 5_000;

interface ActiveChatStream {
  handle: Pick<AgentStreamHandle, "close">;
  generation: number;
  completion: Promise<void>;
  streamState?: ChatStreamConsumptionState;
  stopTranscriptSynchronization?: () => void;
  native?: {
    observer: NativeChatObserver;
    binding: HarnessConversationBinding;
    backend: Backend;
    executing: boolean;
    historyPromptContext?: ChatHistoryPromptContext;
    completedMessages: Set<string>;
    completedTools: Set<string>;
    currentMessageId?: string;
    skipMessage?: boolean;
  };
}

interface StartupOperation {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
  interrupted: boolean;
}

interface ChatTranscriptMemory {
  version: StreamVersion;
  messages: TranscriptMemoryIndex<PersistedMessage>;
  logs: TranscriptMemoryIndex<TaskLogEntry>;
  toolCalls: TranscriptMemoryIndex<PersistedToolCall>;
}

function createChatTranscriptMemory(state: ChatState, maxEntries = Number.POSITIVE_INFINITY): ChatTranscriptMemory {
  const messages = state.messages ?? [];
  const logs = state.logs ?? [];
  const toolCalls = state.toolCalls ?? [];
  const version = new StreamVersion();
  return {
    version,
    messages: new TranscriptMemoryIndex(messages, maxEntries, () => version.advance()),
    logs: new TranscriptMemoryIndex(logs, maxEntries, () => version.advance()),
    toolCalls: new TranscriptMemoryIndex(toolCalls, maxEntries, () => version.advance()),
  };
}

interface ChatStreamConsumptionState {
  chat: Chat;
  transcriptMemory: ChatTranscriptMemory;
  interpreter: AgentEventTranscriptInterpreter;
  lastStatusReloadAt: number;
  completedResponse?: { nativeMessageId: string | null; transcriptMessageId: string };
  deletionCheckpointed?: boolean;
}

interface ChatPromptStartOptions {
  chat: Chat;
  backend: Backend;
  sessionId: string;
  prompt: PromptInput;
  signal?: AbortSignal;
  answerInputId?: string;
  historyPromptContext?: ChatHistoryPromptContext;
  onAdmitted?: () => Promise<void>;
  inputIds?: readonly string[];
}

export type ChatPermissionHandler = (
  chat: Chat,
  backend: Backend,
  request: ChatPermissionRequest,
) => Promise<Chat>;

export interface ChatConversationServiceDependencies {
  attachments: ChatAttachmentService;
  state: ChatStatePort;
  session: ChatSessionPort;
  worktree: ChatWorktreePort;
  historyExport: ChatHistoryExportService;
  emitter?: SimpleEventEmitter<ChatEvent>;
  scheduleQueuedMessageDrain?: (chatId: string) => void;
  permissionHandler?: ChatPermissionHandler;
}

export class ChatConversationService implements ChatConversationPort {
  private readonly activeStreams = new Map<string, ActiveChatStream>();
  private readonly activeStreamGenerations = new Map<string, number>();
  private readonly startupOperations = new Map<string, StartupOperation>();
  private readonly state: ChatStatePort;
  private readonly session: ChatSessionPort;
  private readonly worktree: ChatWorktreePort;
  private readonly historyExport: ChatHistoryExportService;
  private readonly attachments: ChatAttachmentService;
  private readonly emitter: SimpleEventEmitter<ChatEvent>;
  private readonly scheduleQueuedMessageDrain: (chatId: string) => void;
  private permissionHandler: ChatPermissionHandler | undefined;
  private questionHandler?: (chat: Chat, event: AgentEvent, questionMessageId?: string) => Promise<void>;

  constructor(dependencies: ChatConversationServiceDependencies) {
    this.state = dependencies.state;
    this.session = dependencies.session;
    this.worktree = dependencies.worktree;
    this.historyExport = dependencies.historyExport;
    this.attachments = dependencies.attachments;
    this.emitter = dependencies.emitter ?? chatEventEmitter;
    this.scheduleQueuedMessageDrain = dependencies.scheduleQueuedMessageDrain ?? (() => {});
    this.permissionHandler = dependencies.permissionHandler;
  }

  setPermissionHandler(handler: ChatPermissionHandler): void {
    this.permissionHandler = handler;
  }

  getLiveTranscript(chatId: string): LiveTranscriptState | undefined {
    const memory = this.activeStreams.get(chatId)?.streamState?.transcriptMemory;
    if (!memory) return undefined;
    return {
      messages: [...memory.messages.values],
      logs: [...memory.logs.values],
      toolCalls: [...memory.toolCalls.values],
      position: memory.version.position,
    };
  }

  withLiveActivity(chat: Chat): Chat {
    const live = this.activeStreams.get(chat.config.id)?.streamState?.chat.state;
    if (!live) return chat;
    return {
      ...chat,
      state: {
        ...chat.state,
        lastActivityAt: live.lastActivityAt,
        lastUserMessageAt: live.lastUserMessageAt,
      },
    };
  }

  setQuestionHandler(handler: (chat: Chat, event: AgentEvent, questionMessageId?: string) => Promise<void>): void {
    this.questionHandler = handler;
  }

  async runStartupOperation<T>(
    chatId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.startupOperations.has(chatId)) {
      throw new ChatBusyError();
    }
    const startup = createStartupOperation();
    const abort = () => startup.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.startupOperations.set(chatId, startup);
    try {
      throwIfChatStartupAborted(startup.controller.signal);
      return await operation(startup.controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.startupOperations.get(chatId) === startup) {
        this.startupOperations.delete(chatId);
      }
      startup.resolveSettled();
    }
  }

  async dispatchMessage(
    chat: Chat,
    input: NormalizedChatMessageInput,
    options: {
      clearQueuedMessageIds?: readonly string[];
      credentialToken?: string | null;
    } = {},
  ): Promise<Chat> {
    const timer = createChatLatencyTimer();
    this.assertChatIsAvailable(chat);
    if (this.startupOperations.has(chat.config.id)) {
      throw new ChatBusyError();
    }
    const startupOperation = createStartupOperation();
    this.startupOperations.set(chat.config.id, startupOperation);

    const transcriptMessage = input.transcriptMessage;
    const answerInputId = transcriptMessage?.question ? transcriptMessage.id : undefined;
    const answerHarness = answerInputId ? {
      ...chat.state.harness,
      inputs: chat.state.harness?.inputs?.filter(
        (receipt) => receipt.admission.inputId !== answerInputId || receipt.admission.status !== "rejected",
      ),
    } : chat.state.harness;
    let historyPromptContext: ChatHistoryPromptContext | null = null;
    let historyPromptTransferred = false;
    let promptAttempted = false;
    let preparingAttachments = false;
    const userMessage: MessageData = (transcriptMessage && chat.state.messages.find(
      (message) => message.id === transcriptMessage.id,
    )) ?? transcriptMessage ?? {
      id: options.clearQueuedMessageIds?.length
        ? `chat-user-${new Bun.CryptoHasher("sha256").update(JSON.stringify(options.clearQueuedMessageIds)).digest("hex")}`
        : `chat-user-${crypto.randomUUID()}`,
      role: "user",
      content: input.message,
      attachments: input.attachments.length > 0 ? input.attachments : undefined,
      timestamp: createTimestamp(),
    };

    try {
      const historyRecovery = chat.state.harness?.historyRecovery;
      if (historyRecovery) {
        historyPromptContext = await this.historyExport.prepareForPrompt(
          chat,
          historyRecovery,
          {
            credentialToken: options.credentialToken,
            signal: startupOperation.controller.signal,
          },
        );
        chat = await this.state.getChat(chat.config.id) ?? chat;
      }

      const startupStage = isExecutionHostChat(chat)
        || this.worktree.hasEstablishedWorkspaceContext(chat)
        ? "connecting_provider" as const
        : "preparing_workspace" as const;
      const deferQueuedMessage = !transcriptMessage && Boolean(options.clearQueuedMessageIds?.length);
      const startingState: ChatState = {
        ...chat.state,
        status: "starting",
        startupStage,
        error: undefined,
        completedAt: undefined,
        activeMessageId: undefined,
        interruptRequested: false,
        harness: {
          ...(answerInputId
            ? updateQuestionAnswerStatus(answerHarness, answerInputId, "submitting")
            : chat.state.harness),
          activeTurnAttachmentBytes: getMessageAttachmentByteLength(input.attachments),
        },
      };
      let current = await timer.measure("message_persistence", () => deferQueuedMessage
        ? this.updateState(chat, startingState, { expectedStatus: chat.state.status })
        : this.appendMessage(chat, userMessage, startingState, chat.state.status));
      if (options.clearQueuedMessageIds) {
        this.emitChatUpdated(current);
      }

      let workingDirectory: ChatDirectoryResolution | undefined;
      if (isExecutionHostChat(current)) {
        throwIfChatStartupAborted(startupOperation.controller.signal);
        current = await this.state.updateStartupStage(current, "connecting_provider", {
          expectedStatus: current.state.status,
        });
      } else {
        workingDirectory = await timer.measure("worktree_preparation", () =>
          this.worktree.resolveWorkingDirectory(current, {
            prepareWorkspace: !this.worktree.hasEstablishedWorkspaceContext(current),
            signal: startupOperation.controller.signal,
          })
        );
        throwIfChatStartupAborted(startupOperation.controller.signal);
        const stagedWorking = {
          ...workingDirectory,
          chat: await this.state.updateStartupStage(workingDirectory.chat, "connecting_provider", {
            expectedStatus: workingDirectory.chat.state.status,
          }),
        };
        workingDirectory = stagedWorking;
        current = stagedWorking.chat;
      }

      let backend!: Backend;
      let startupAttempt = 0;
      while (true) {
        try {
          backend = await timer.measure("backend_connection", () =>
            this.session.ensureBackendConnected(
              current,
              {
                credentialToken: options.credentialToken,
                signal: startupOperation.controller.signal,
              },
              workingDirectory,
            )
          );
          current = await timer.measure("session_creation", () =>
            this.session.ensureSession(current, backend, {
              workingDirectory,
              signal: startupOperation.controller.signal,
            })
          );
          break;
        } catch (error) {
          if (
            startupAttempt === 0
            && !startupOperation.controller.signal.aborted
            && isRecoverableChatStartupFailure(error)
          ) {
            startupAttempt++;
            log.warn("Retrying chat startup after a transient ACP failure", {
              chatId: chat.config.id,
              error: getAcpErrorMessage(error),
            });
            await this.session.disconnectChat(chat.config.id);
            current = await this.loadChatIfAvailable(chat.config.id) ?? current;
            continue;
          }
          throw error;
        }
      }
      throwIfChatStartupAborted(startupOperation.controller.signal);
      if (!current.state.session?.id) {
        throw new Error("Failed to establish chat session");
      }

      current = await this.state.updateStartupStage(current, "sending_prompt", {
        expectedStatus: current.state.status,
      });
      const controlContext = current.state.session?.binding?.controlTools
        ? {
            chatId: current.config.id,
            ...(input.clientId ? { clientId: input.clientId } : {}),
            turnId: crypto.randomUUID(),
            workspaceId: getChatWorkspaceId(current),
            defaultModel: current.config.model,
          }
        : undefined;
      preparingAttachments = true;
      const attachmentFiles = await this.attachments.prepare(current, userMessage, {
        credentialToken: options.credentialToken,
        signal: startupOperation.controller.signal,
      });
      preparingAttachments = false;
      throwIfChatStartupAborted(startupOperation.controller.signal);
      if (options.clearQueuedMessageIds?.length && backend.harness.capabilities.adapter === "acp") {
        current = await this.state.mutateState(chat.config.id, (latest) => ({
          ...latest.state,
          messages: deferQueuedMessage
            ? [...latest.state.messages.filter((message) => message.id !== userMessage.id), userMessage]
            : latest.state.messages,
          queuedMessages: latest.state.queuedMessages?.filter(
            (entry) => !options.clearQueuedMessageIds?.includes(entry.id),
          ),
        }));
        if (deferQueuedMessage) this.emitMessage(current, userMessage);
        this.emitChatUpdated(current);
      }
      const prompt: PromptInput = {
        parts: [
          ...(historyPromptContext
            ? [{ type: "text" as const, text: historyPromptContext.instruction }]
            : []),
          ...buildPromptParts(input.message, input.attachments, attachmentFiles),
        ],
        model: current.config.model,
        ...(controlContext ? { controlContext } : {}),
      };
      const started = await timer.measure("prompt_start", () => {
        promptAttempted = true;
        return this.startActivePrompt({
          chat: current,
          backend,
          sessionId: current.state.session!.id,
          prompt,
          signal: startupOperation.controller.signal,
          answerInputId,
          historyPromptContext: historyPromptContext ?? undefined,
          inputIds: options.clearQueuedMessageIds?.length ? options.clearQueuedMessageIds : [userMessage.id],
          onAdmitted: async () => {
            const updated = await this.state.mutateState(chat.config.id, (latest) => ({
              ...latest.state,
              messages: deferQueuedMessage
                ? [...latest.state.messages.filter((message) => message.id !== userMessage.id), userMessage]
                : latest.state.messages,
              queuedMessages: latest.state.queuedMessages?.filter(
                (entry) => !options.clearQueuedMessageIds?.includes(entry.id),
              ),
              harness: {
                ...latest.state.harness,
                inputs: latest.state.harness?.inputs?.filter((receipt) =>
                  receipt.admission.inputId !== userMessage.id
                  && !options.clearQueuedMessageIds?.includes(receipt.admission.inputId)),
              },
            }));
            if (deferQueuedMessage) this.emitMessage(updated, userMessage);
            this.emitChatUpdated(updated);
          },
        });
      });
      historyPromptTransferred = historyPromptContext !== null;
      this.scheduleAutogeneratedChatName(started, backend, input.message);
      return started;
    } catch (error) {
      if (!historyPromptTransferred) {
        historyPromptContext?.close();
      }
      let latest = await this.loadChatIfAvailable(chat.config.id);
      if (isDomainError(error) && error.code === "harness_session_busy") {
        const entry = this.activeStreams.get(chat.config.id);
        if (entry?.native) entry.native.executing = true;
        if (latest) {
          await this.state.mutateState(chat.config.id, (current) => ({
            ...current.state, status: "streaming", startupStage: undefined, error: undefined,
          }));
        }
        if (!options.clearQueuedMessageIds?.length) input.transcriptMessage ??= userMessage;
        throw new ChatBusyError();
      }
      if (latest && answerInputId && !(error instanceof ChatBusyError)) {
        latest = await this.state.mutateState(chat.config.id, (current) => {
          const answered = current.state.harness?.questions?.some(
            (request) => request.transcript?.answerMessageId === answerInputId && request.status === "answered",
          );
          return answered ? undefined : {
            ...current.state,
            harness: updateQuestionAnswerStatus(current.state.harness, answerInputId,
              promptAttempted && !isHarnessInputValidationError(error) ? "unconfirmed" : "pending"),
          };
        });
        this.state.emitChatUpdated(latest);
      }
      if (startupOperation.interrupted) {
        if (this.startupOperations.get(chat.config.id) === startupOperation && latest) {
          return await this.completeInterruptedChat(latest);
        }
        return latest ?? chat;
      }
      if (error instanceof ChatBusyError) {
        throw error;
      }
      const erroredChat = await this.emitChatError(latest ?? chat, error);
      const adapter = erroredChat.state.session?.binding?.adapter;
      if (!preparingAttachments && (erroredChat.state.queuedMessages ?? []).length > 0 && (!adapter || adapter === "acp")) {
        this.scheduleQueuedMessageDrain(chat.config.id);
      }
      throw error;
    } finally {
      if (this.startupOperations.get(chat.config.id) === startupOperation) {
        this.startupOperations.delete(chat.config.id);
      }
      startupOperation.resolveSettled();
      const timing = timer.complete();
      log.info("Chat first-message timing", {
        chatId: chat.config.id,
        totalMs: timing.totalMs,
        stages: timing.stages,
      });
    }
  }

  async waitForChatIdle(chatId: string, timeoutMs = DEFAULT_CHAT_IDLE_WAIT_TIMEOUT_MS): Promise<Chat> {
    const startedAt = Date.now();
    while (true) {
      const summary = await this.state.getChatSummary(chatId);
      if (!summary) {
        throw new Error(`Chat not found: ${chatId}`);
      }
      if (!this.hasActiveStream(chatId) && !isChatBusyStatus(summary.state.status)) {
        return await this.state.getChat(chatId) ?? summary;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for chat to become idle: ${chatId}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async interruptChat(chatId: string, reason?: string): Promise<Chat | null> {
    let chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    const startupOperation = this.startupOperations.get(chatId);
    const activeStream = this.activeStreams.get(chatId);
    if (!chat.state.session?.id && !startupOperation && !activeStream) {
      return chat;
    }

    chat = await this.state.getChat(chatId) ?? chat;
    startupOperation?.controller.abort();
    if (startupOperation) {
      startupOperation.interrupted = true;
    }
    const markInterrupting = async (candidate: Chat): Promise<void> => {
      await this.updateState(candidate, {
        ...candidate.state,
        status: "interrupting",
        interruptRequested: true,
        harness: {
          ...candidate.state.harness,
          questions: closeOpenQuestions(candidate.state.harness?.questions, "cancelled"),
        },
        lastActivityAt: createTimestamp(),
      }, {
        expectedStatus: candidate.state.status,
      });
    };
    try {
      await markInterrupting(chat);
    } catch (error) {
      if (!(error instanceof ChatBusyError)) {
        throw error;
      }
      const latest = await this.state.getChat(chatId);
      if (!latest) {
        return null;
      }
      chat = latest;
      await markInterrupting(chat);
    }

    if (activeStream?.native) await this.stopNativeObservation(chatId);
    else if (activeStream) this.closeActiveStream(chatId);

    let backend: Backend | undefined;
    if (!startupOperation && chat.state.session?.id) {
      try {
        backend = this.session.getChatBackend(chat.config.id, chat.config.workspaceId);
      } catch (error) {
        log.warn("Chat backend was unavailable during interrupt", {
          chatId,
          error: String(error),
        });
      }
    }

    if (backend?.isConnected() && chat.state.session?.id) {
      try {
        await withTimeout(
          backend.abortSession(chat.state.session.id),
          CHAT_INTERRUPT_ABORT_TIMEOUT_MS,
          "Chat session abort timed out",
        );
      } catch (error) {
        log.warn("Failed to abort chat session during interrupt", {
          chatId,
          sessionId: chat.state.session.id,
          error: String(error),
        });
      }
    }

    if (startupOperation || activeStream || backend) {
      try {
        await this.session.disconnectChat(chatId);
      } catch (error) {
        log.warn("Failed to disconnect chat backend during interrupt", {
          chatId,
          error: String(error),
        });
      }
    }
    if (startupOperation) {
      if (activeStream) {
        await activeStream.completion;
      }
      await withTimeout(
        startupOperation.settled,
        CHAT_INTERRUPT_STARTUP_SETTLE_TIMEOUT_MS,
        "Chat startup cancellation timed out",
      ).catch((error) => {
        log.warn("Chat startup did not settle promptly after interrupt", {
          chatId,
          error: String(error),
        });
      });
    }
    const latestChat = await this.state.getChat(chatId);
    if (!latestChat) {
      return null;
    }
    if (reason) {
      log.info("Chat interrupted by user request", { chatId, reason });
    }
    const currentStartupOperation = this.startupOperations.get(chatId);
    const preserveStartupFailure = startupOperation?.interrupted
      && latestChat.state.status === "failed";
    const shouldCompleteInterrupt = (
      startupOperation?.interrupted
      && (!currentStartupOperation || currentStartupOperation === startupOperation)
    ) || activeStream
      || latestChat.state.status === "interrupting"
      || latestChat.state.interruptRequested;
    const completed = !preserveStartupFailure && shouldCompleteInterrupt
      ? await this.completeInterruptedChat(latestChat)
      : latestChat;
    this.scheduleQueuedMessageDrain(chatId);
    return completed;
  }

  closeActiveStream(chatId: string): void {
    const active = this.activeStreams.get(chatId);
    active?.handle.close();
    active?.stopTranscriptSynchronization?.();
    active?.native?.historyPromptContext?.close();
    this.activeStreams.delete(chatId);
    this.activeStreamGenerations.delete(chatId);
  }

  async stopNativeObservation(chatId: string): Promise<void> {
    const stream = this.activeStreams.get(chatId);
    if (!stream?.native) return;
    if (stream.native.observer.isClosed) {
      await stream.completion;
      return;
    }
    const state = stream.streamState!;
    await stream.native.observer.serialize(async () => {
      await this.flushChatStreamBlocksAfterMetadataReload(chatId, state, state.interpreter.flushActiveBlocks());
      state.interpreter.acknowledgeCheckpoint();
      this.closeActiveStream(chatId);
    });
    await stream.completion;
  }

  checkpointForDeletion(
    chatId: string,
    markDeleted: (chatId: string, checkpoint?: TranscriptChangeSet) => Chat | null,
  ): Chat | null {
    const streamState = this.activeStreams.get(chatId)?.streamState;
    const upserts: TranscriptChangeSet["upserts"] = [];
    if (streamState?.interpreter.getPendingCheckpointBytes()) {
      // Earlier blocks are checkpointed before the next block is displayed.
      const message = streamState.transcriptMemory.messages.values.findLast(
        (entry) => entry.role === "assistant" && !entry.question,
      );
      const reasoning = streamState.transcriptMemory.logs.values.findLast(
        (entry) => entry.details?.["logKind"] === "reasoning",
      );
      if (message) upserts.push({ id: message.id, kind: "message", timestamp: message.timestamp, payload: message });
      if (reasoning) upserts.push({ id: reasoning.id, kind: "log", timestamp: reasoning.timestamp, payload: reasoning });
    }
    // Capture displayed text and install the fence in one synchronous transaction.
    const deleted = markDeleted(chatId, streamState
      ? createTranscriptChangeSet(streamState.chat.state, upserts) : undefined);
    if (deleted && streamState) streamState.deletionCheckpointed = true;
    return deleted;
  }

  async stopForDeletion(chatId: string): Promise<void> {
    const startup = this.startupOperations.get(chatId);
    const stream = this.activeStreams.get(chatId);
    startup?.controller.abort();
    this.closeActiveStream(chatId);
    await withTimeout(
      Promise.all([startup?.settled, stream?.completion]),
      CHAT_INTERRUPT_STARTUP_SETTLE_TIMEOUT_MS,
      "Chat cancellation did not finish before deletion",
    );
  }

  hasActiveStream(chatId: string): boolean {
    const stream = this.activeStreams.get(chatId);
    return stream !== undefined && (!stream.native || stream.native.executing);
  }

  async observeNativeSession({ chat, backend, binding, recover }: {
    chat: Chat;
    backend: Backend;
    binding: HarnessConversationBinding;
    recover: boolean;
  }): Promise<void> {
    const chatId = chat.config.id;
    const previous = this.activeStreams.get(chatId);
    if (previous?.native?.binding.nativeId === binding.nativeId && previous.native.backend === backend
      && !previous.native.observer.isClosed) {
      requireMatchingHarnessBinding(JSON.stringify(previous.native.binding), binding);
      return;
    }
    await this.stopNativeObservation(chatId);
    this.closeActiveStream(chatId);
    const observer = new NativeChatObserver();
    const generation = this.nextActiveStreamGeneration(chatId);
    const entry: ActiveChatStream = {
      handle: observer, generation, completion: Promise.resolve(),
      streamState: this.createChatStreamState(chat, 1000),
      native: { observer, backend, binding, executing: false, completedMessages: new Set(), completedTools: new Set() },
    };
    this.activeStreams.set(chatId, entry);
    entry.stopTranscriptSynchronization = this.synchronizePersistedMessages(chatId, entry.streamState!);
    try {
      await observer.start({
        backend, sessionId: binding.nativeId,
        recover: async () => {
          if (recover) await this.recoverNativeSession(chatId, entry);
        },
        onEvent: async (event) => {
          if (this.activeStreams.get(chatId) !== entry) return;
          const latest = await this.state.getChatSummary(chatId);
          if (!latest || latest.state.session?.binding?.nativeId !== binding.nativeId) {
            observer.close();
            return;
          }
          if (latest.state.status === "done") {
            observer.close();
            return;
          }
          requireMatchingHarnessBinding(JSON.stringify(latest.state.session.binding), binding);
          if (event.scope.kind !== "principal"
            && event.type !== "question.asked" && event.type !== "question.resolved"
            && event.type !== "permission.asked") return;
          await this.consumeNativeEvent(chatId, entry, event);
        },
        onFailure: async (error) => {
          if (this.activeStreams.get(chatId) !== entry) return;
          const streamState = entry.streamState!;
          try {
            await this.flushChatStreamBlocksAfterMetadataReload(chatId, streamState, streamState.interpreter.flushActiveBlocks());
          } catch (checkpointError) {
            log.error("Failed to checkpoint native conversation after observation failure", { chatId, error: String(checkpointError) });
          } finally {
            await this.cancelUnobservedNativeExecution(chatId, entry);
          }
          const latest = await this.state.getChatSummary(chatId);
          if (latest && this.activeStreams.get(chatId) === entry
            && latest.state.session?.binding?.nativeId === binding.nativeId) await this.emitChatError(latest, error);
        },
        onClosed: () => {
          if (this.activeStreams.get(chatId) === entry) this.closeActiveStream(chatId);
        },
      });
      entry.completion = observer.completion;
    } catch (error) {
      try {
        await this.cancelUnobservedNativeExecution(chatId, entry);
      } finally {
        if (this.activeStreams.get(chatId) === entry) this.closeActiveStream(chatId);
      }
      throw error;
    }
  }

  private async cancelUnobservedNativeExecution(chatId: string, entry: ActiveChatStream): Promise<void> {
    const native = entry.native!;
    if (this.activeStreams.get(chatId) !== entry || !native.backend.isConnected()) return;
    try {
      await withTimeout(native.backend.abortSession(native.binding.nativeId), CHAT_INTERRUPT_ABORT_TIMEOUT_MS, "Unobserved native execution abort timed out");
    } catch (error) {
      log.error("Failed to abort unobserved native execution; disconnecting its runtime", { chatId, error: String(error) });
      try {
        await withTimeout(native.backend.disconnect(), CHAT_INTERRUPT_ABORT_TIMEOUT_MS, "Unobserved native runtime disconnect timed out");
      } catch (disconnectError) {
        log.error("Failed to disconnect unobserved native runtime", { chatId, error: String(disconnectError) });
      }
    }
  }

  private async consumeNativeEvent(chatId: string, entry: ActiveChatStream, event: AgentEvent, recovered = false): Promise<void> {
    const native = entry.native!;
    if (event.type === "message.complete") await this.reconcileNativeCompletionIdentity(chatId, entry, event);
    if (event.type === "message.delta" || event.type === "message.complete") {
      if (event.messageId && native.completedMessages.has(event.messageId)) return;
      if (event.messageId && (!native.currentMessageId || native.completedMessages.has(native.currentMessageId))) {
        await this.consumeNativeEvent(chatId, entry, {
          type: "message.start", messageId: event.messageId, scope: event.scope, timestamp: event.timestamp,
        }, recovered);
      }
    }
    const streamState = entry.streamState!;
    if ((event.type === "tool.start" || event.type === "tool.complete")
      && event.toolCallId && native.completedTools.has(event.toolCallId)) return;
    if (event.type === "message.start") {
      if (native.currentMessageId && native.currentMessageId !== event.messageId
        && !native.completedMessages.has(native.currentMessageId)
        && streamState.interpreter.state.responseContent.length > 0) {
        throw new HarnessError("harness_event_gap", "Native message identities changed before the pending response completed.");
      }
      native.currentMessageId = event.messageId;
      native.skipMessage = native.completedMessages.has(event.messageId);
    }
    if (native.skipMessage && (event.type === "message.start" || event.type === "message.delta" || event.type === "message.complete")) return;
    if (!recovered && event.scope.kind === "principal"
      && (event.type === "session.status" && event.status !== "idle" || event.type === "message.start")) {
      native.executing = true;
      if (!await this.reloadChatStreamMetadata(chatId, streamState)) return;
      if (!streamState.chat.state.interruptRequested) {
        streamState.chat = await this.updateState(streamState.chat, {
          ...streamState.chat.state, status: "streaming", startupStage: undefined,
          error: undefined, completedAt: undefined, lastActivityAt: createTimestamp(),
        });
      }
    }
    await this.handleChatStreamEvent(chatId, native.backend, entry.generation, streamState, event);
    if (!recovered && event.type === "message.start") {
      await this.recordNativeMessageCheckpoint(chatId, entry, event.messageId);
    }
    if (event.type === "message.complete" && native.currentMessageId) {
      this.rememberNativeCompletion(native.completedMessages, native.currentMessageId);
      if (!recovered) await this.recordNativeMessageCheckpoint(chatId, entry, undefined);
    }
    if (event.type === "tool.complete" && event.toolCallId) {
      this.rememberNativeCompletion(native.completedTools, event.toolCallId);
    }
    const tools = streamState.interpreter.state.toolCalls;
    for (const [id, tool] of tools) {
      if (tools.size <= 1000) break;
      if (tool.status !== "running") tools.delete(id);
    }
    if (tools.size > 1000) throw new HarnessError("harness_event_gap", "Native conversation has too many active tools.");
    if (event.scope.kind === "principal" && (event.type === "prompt.complete" || event.type === "error")) {
      native.executing = false;
      if (event.type === "prompt.complete" && event.outcome === "completed") {
        try {
          await native.historyPromptContext?.complete();
        } catch (error) {
          log.warn("Failed to clean up completed native chat history export", { chatId, error: String(error) });
        }
      }
      native.historyPromptContext?.close();
      native.historyPromptContext = undefined;
      const completedResponse = streamState.completedResponse;
      entry.stopTranscriptSynchronization?.();
      entry.streamState = this.createChatStreamState(streamState.chat, 1000);
      entry.streamState.completedResponse = completedResponse;
      entry.stopTranscriptSynchronization = this.synchronizePersistedMessages(chatId, entry.streamState);
      this.scheduleQueuedMessageDrain(chatId);
    }
  }

  private async recoverNativeSession(chatId: string, entry: ActiveChatStream): Promise<void> {
    const native = entry.native!;
    if (!native.backend.readSessionHistory) throw new HarnessError("harness_event_gap", "This execution host cannot recover native conversation history.");
    await this.verifyNativeMessageCheckpoint(chatId, entry);
    let cursor: string | undefined;
    do {
      const history = await native.backend.readSessionHistory(native.binding.nativeId, cursor);
      const finalMessages = new Map<string, Extract<AgentEvent, { type: "message.complete" }>>();
      let messageId: string | undefined;
      for (const event of history.events) {
        if (event.scope.kind !== "principal") continue;
        if (event.type === "message.start") messageId = event.messageId;
        if (event.type === "message.complete" && messageId) finalMessages.set(messageId, event);
      }
      for (const event of history.events) {
        if (event.scope.kind !== "principal") continue;
        if (event.type === "message.start") {
          const persisted = await this.state.getChatMessage(chatId, event.messageId);
          const final = finalMessages.get(event.messageId);
          if (persisted && final) {
            await this.reconcileRecoveredMessage({ chatId, entry, persisted, final });
            this.rememberNativeCompletion(native.completedMessages, event.messageId);
          }
        }
        if ((event.type === "tool.start" || event.type === "tool.complete") && event.toolCallId) {
          const tool = await this.state.getChatToolCall(chatId, event.toolCallId);
          if (tool && tool.status !== "running") this.rememberNativeCompletion(native.completedTools, event.toolCallId);
        }
        await this.consumeNativeEvent(chatId, entry, event, true);
      }
      native.executing = history.principalProcessing;
      cursor = history.nextCursor;
    } while (cursor);
    native.currentMessageId = undefined;
    native.skipMessage = false;
    await this.recordNativeMessageCheckpoint(chatId, entry, undefined);
    const streamState = entry.streamState!;
    if (!await this.reloadChatStreamMetadata(chatId, streamState)) return;
    streamState.chat = await this.updateState(streamState.chat, {
      ...streamState.chat.state,
      status: streamState.chat.state.status === "starting" || streamState.chat.state.status === "reconnecting"
        ? streamState.chat.state.status : native.executing ? "streaming" : "idle",
      startupStage: undefined, error: undefined, interruptRequested: false,
    });
  }

  private rememberNativeCompletion(ids: Set<string>, id: string): void {
    ids.add(id);
    if (ids.size > 1000) ids.delete(ids.values().next().value!);
  }

  private async recordNativeMessageCheckpoint(chatId: string, entry: ActiveChatStream, messageId: string | undefined): Promise<void> {
    const native = entry.native!;
    const updated = await this.state.mutateState(chatId, (current) => {
      if (!current.state.session?.binding) throw new HarnessError("harness_session_not_found", "The native conversation is unavailable.");
      requireMatchingHarnessBinding(JSON.stringify(native.binding), current.state.session.binding);
      return {
        ...current.state,
        harness: {
          ...current.state.harness,
          unfinishedMessage: messageId ? { nativeId: native.binding.nativeId, messageId } : undefined,
        },
      };
    });
    const streamState = entry.streamState!;
    streamState.chat = { ...streamState.chat, state: { ...streamState.chat.state, harness: updated.state.harness } };
  }

  private async verifyNativeMessageCheckpoint(chatId: string, entry: ActiveChatStream): Promise<void> {
    const native = entry.native!;
    const checkpoint = entry.streamState!.chat.state.harness?.unfinishedMessage;
    if (!checkpoint || checkpoint.nativeId !== native.binding.nativeId
      || !await this.state.getChatMessage(chatId, checkpoint.messageId)) return;
    let cursor: string | undefined;
    let matched = false;
    do {
      const history = await native.backend.readSessionHistory!(native.binding.nativeId, cursor);
      let messageId: string | undefined;
      for (const event of history.events) {
        if (event.scope.kind !== "principal") continue;
        if (event.type === "message.start") messageId = event.messageId;
        if (event.type === "message.complete" && messageId === checkpoint.messageId) matched = true;
      }
      cursor = history.nextCursor;
    } while (cursor);
    if (!matched) throw new HarnessError("harness_event_gap", "An unfinished native response cannot be correlated with completed provider history.");
  }

  private async reconcileNativeCompletionIdentity(
    chatId: string,
    entry: ActiveChatStream,
    event: Extract<AgentEvent, { type: "message.complete" }>,
  ): Promise<void> {
    const native = entry.native!;
    const provisionalId = native.currentMessageId;
    if (!event.messageId || !provisionalId || event.messageId === provisionalId
      || native.completedMessages.has(provisionalId)) return;
    const streamState = entry.streamState!;
    const content = event.content || streamState.interpreter.state.responseContent;
    await this.flushChatStreamBlocksAfterMetadataReload(chatId, streamState, streamState.interpreter.flushActiveBlocks());
    const provisional = await this.state.getChatMessage(chatId, provisionalId);
    if (provisional) {
      await this.reconcileRecoveredMessage({
        chatId, entry, persisted: provisional, final: { ...event, content },
      });
    }
    this.rememberNativeCompletion(native.completedMessages, provisionalId);
    native.currentMessageId = undefined;
    native.skipMessage = false;
  }

  private async reconcileRecoveredMessage({
    chatId,
    entry,
    persisted,
    final,
  }: {
    chatId: string;
    entry: ActiveChatStream;
    persisted: MessageData;
    final: Extract<AgentEvent, { type: "message.complete" }>;
  }): Promise<void> {
    const segments: MessageData[] = [persisted];
    for (let index = 2; index <= 257; index++) {
      const segment = await this.state.getChatMessage(chatId, this.createResponseSegmentMessageId(persisted.id, index));
      if (!segment) break;
      if (index === 257) throw new HarnessError("harness_event_gap", "Recovered native message has too many transcript segments.");
      segments.push(segment);
    }
    const finalId = final.messageId ?? persisted.id;
    if (finalId === persisted.id && segments.map((segment) => segment.content).join("") === final.content
      && (!final.attachments || JSON.stringify(persisted.attachments) === JSON.stringify(final.attachments))) return;
    const streamState = entry.streamState!;
    if (!await this.reloadChatStreamMetadata(chatId, streamState)) return;
    const ids = new Set([...segments.map((segment) => segment.id), finalId]);
    const message: MessageData = { ...persisted, id: finalId, content: final.content, attachments: final.attachments ?? persisted.attachments };
    const nextState = {
      ...streamState.chat.state,
      harness: streamState.chat.state.harness?.unfinishedMessage ? {
        ...streamState.chat.state.harness,
        unfinishedMessage: { nativeId: entry.native!.binding.nativeId, messageId: finalId },
      } : streamState.chat.state.harness,
      messages: [...streamState.transcriptMemory.messages.values.filter((value) => !ids.has(value.id)), message],
    };
    const updated = await this.updateState(streamState.chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: message.id, kind: "message", timestamp: message.timestamp, payload: message,
      }], segments.filter((segment) => segment.id !== finalId).map((segment) => ({ id: segment.id, kind: "message" as const }))),
    });
    entry.stopTranscriptSynchronization?.();
    entry.streamState = this.createChatStreamState(updated, 1000);
    entry.stopTranscriptSynchronization = this.synchronizePersistedMessages(chatId, entry.streamState);
    this.emitMessage(updated, message);
  }

  async getAssistantMessage(
    chatId: string,
    messageId: string,
  ): Promise<MessageData | null> {
    const chat = await this.state.getChatSummary(chatId);
    if (!chat) {
      return null;
    }

    const activeMessage = this.activeStreams.get(chatId)?.streamState?.chat.state.messages.find(
      (message) => message.id === messageId,
    );
    const message = activeMessage ?? await this.state.getChatMessage(chatId, messageId);
    return message?.role === "assistant" ? message : null;
  }

  private async startNativePrompt(options: ChatPromptStartOptions): Promise<Chat> {
    const { chat, backend, sessionId, prompt, signal, answerInputId, historyPromptContext, onAdmitted, inputIds = [] } = options;
    const entry = this.activeStreams.get(chat.config.id);
    if (!entry?.native) throw new HarnessError("harness_transport_closed", "Native conversation observation is unavailable.");
    return entry.native.observer.serialize(async () => {
      throwIfChatStartupAborted(signal);
      if (entry.native!.executing) throw new HarnessError("harness_session_busy", "The native principal is already executing.");
      const admission = { chatId: chat.config.id, binding: entry.native!.binding, inputIds };
      await this.recordNativePromptAdmission({ ...admission, status: "unknown" });
      try {
        await backend.sendPromptAsync(sessionId, prompt);
      } catch (error) {
        if (isHarnessInputValidationError(error) || (isDomainError(error) && error.code === "harness_session_busy")) {
          await this.recordNativePromptAdmission({ ...admission, status: null });
        }
        throw error;
      }
      throwIfChatStartupAborted(signal);
      if (this.activeStreams.get(chat.config.id) !== entry) {
        throw new HarnessError("harness_transport_closed", "The native conversation changed during admission.");
      }
      await onAdmitted?.();
      entry.native!.historyPromptContext = historyPromptContext;
      entry.native!.executing = true;
      const latest = await this.state.getChatSummary(chat.config.id);
      if (!latest) throw new HarnessError("harness_session_not_found", "The chat is unavailable.");
      return this.updateState(latest, {
        ...latest.state, status: "streaming", startupStage: undefined, error: undefined,
        interruptRequested: false, completedAt: undefined, lastActivityAt: createTimestamp(),
        harness: answerInputId
          ? updateQuestionAnswerStatus(latest.state.harness, answerInputId, "answered")
          : latest.state.harness,
      });
    });
  }

  private async recordNativePromptAdmission({ chatId, binding, inputIds, status }: {
    chatId: string;
    binding: HarnessConversationBinding;
    inputIds: readonly string[];
    status: "unknown" | null;
  }): Promise<void> {
    if (inputIds.length === 0) return;
    const updated = await this.state.mutateState(chatId, (current) => {
      if (!current.state.session?.binding) throw new HarnessError("harness_session_not_found", "The native conversation is unavailable.");
      requireMatchingHarnessBinding(JSON.stringify(binding), current.state.session.binding);
      let receipts = current.state.harness?.inputs ?? [];
      for (const inputId of inputIds) {
        const previous = receipts.find((receipt) => receipt.admission.inputId === inputId);
        if (status === "unknown" && previous && previous.admission.status !== "rejected") {
          throw new HarnessError("harness_input_unresolved", "This input may already have been delivered.");
        }
        receipts = status === null
          ? receipts.filter((receipt) => receipt.admission.inputId !== inputId)
          : retainHarnessInputReceipt(receipts, {
            conversation: binding, admission: { status, inputId }, submittedAt: previous?.submittedAt ?? createTimestamp(),
          });
      }
      return { ...current.state, harness: { ...current.state.harness, inputs: receipts } };
    });
    this.state.emitChatUpdated(updated);
  }

  private async startActivePrompt(options: ChatPromptStartOptions): Promise<Chat> {
    const { chat, backend, sessionId, prompt, signal, answerInputId, historyPromptContext } = options;
    throwIfChatStartupAborted(signal);
    if (backend.harness.capabilities.adapter !== "acp") return this.startNativePrompt(options);
    const streamController = new AgentStreamController(backend);
    const handle = streamController.start({
      sessionId,
      prompt,
      activityTimeoutMs: backend.harness.capabilities.adapter === "acp"
        ? DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS
        : null,
    });
    const generation = this.nextActiveStreamGeneration(chat.config.id);
    const activeStream: ActiveChatStream = {
      handle,
      generation,
      completion: Promise.resolve(),
    };
    this.activeStreams.set(chat.config.id, activeStream);
    try {
      throwIfChatStartupAborted(signal);
      const streamingChat = await this.updateState(chat, {
        ...chat.state,
        status: "streaming",
        error: undefined,
        interruptRequested: false,
        completedAt: undefined,
        lastActivityAt: createTimestamp(),
      }, {
        expectedStatus: chat.state.status,
      });
      throwIfChatStartupAborted(signal);
      const started = await handle.startPrompt();
      if (!started) {
        this.clearActiveStream(chat.config.id, generation);
        historyPromptContext?.close();
        if (answerInputId) {
          await this.state.mutateState(chat.config.id, (current) => ({
            ...current.state, harness: updateQuestionAnswerStatus(current.state.harness, answerInputId, "pending"),
          }));
        }
        return await this.state.getChat(chat.config.id) ?? chat;
      }
      const startedChat = answerInputId
        ? await this.state.mutateState(chat.config.id, (current) => ({
            ...current.state,
            harness: updateQuestionAnswerStatus(current.state.harness, answerInputId, "answered"),
            startupStage: undefined,
            lastActivityAt: createTimestamp(),
          }))
        : await this.updateState(streamingChat, {
            ...streamingChat.state,
            startupStage: undefined,
            lastActivityAt: createTimestamp(),
          }, { expectedStatus: streamingChat.state.status });
      if (answerInputId) this.state.emitChatUpdated(startedChat);
      throwIfChatStartupAborted(signal);
      activeStream.completion = this.consumeEventStream(
        chat.config.id,
        backend,
        handle,
        generation,
        startedChat,
        historyPromptContext,
      );
      return startedChat;
    } catch (error) {
      this.clearActiveStream(chat.config.id, generation);
      handle.close();
      historyPromptContext?.close();
      throw error;
    }
  }

  private createChatStreamState(initialChat: Chat, maxEntries = Number.POSITIVE_INFINITY): ChatStreamConsumptionState {
    const transcriptMemory = createChatTranscriptMemory(initialChat.state, maxEntries);
    return {
      chat: initialChat,
      transcriptMemory,
      interpreter: new AgentEventTranscriptInterpreter({
        initialToolCalls: transcriptMemory.toolCalls.values,
        checkpointPolicy: new AgentStreamCheckpointPolicy(),
        idFactories: {
          createResponseMessageId: (state) =>
            this.createResponseSegmentMessageId(state.currentMessageId, state.responseSegmentCount),
          createResponseLogId: () => `chat-log-${crypto.randomUUID()}`,
          createToolCallId: (event) =>
            event.toolCallId ?? `chat-tool-${crypto.randomUUID()}`,
        },
      }),
      lastStatusReloadAt: 0,
    };
  }

  private async consumeEventStream(
    chatId: string,
    backend: Backend,
    handle: AgentStreamHandle,
    generation: number,
    initialChat: Chat,
    historyPromptContext?: ChatHistoryPromptContext,
  ): Promise<void> {
    const streamState = this.createChatStreamState(initialChat);
    const activeStream = this.activeStreams.get(chatId);
    let stopTranscriptSynchronization: (() => void) | undefined;
    if (activeStream?.generation === generation) {
      activeStream.streamState = streamState;
      stopTranscriptSynchronization = this.synchronizePersistedMessages(chatId, streamState);
      activeStream.stopTranscriptSynchronization = stopTranscriptSynchronization;
    }
    const sessionId = streamState.chat.state.session?.id;
    let canDrain = backend.harness.capabilities.adapter === "acp";

    try {
      const streamResult = await handle.consume({
        isWaitingForInput: async () => (await this.state.getChatSummary(chatId))?.state.harness?.questions?.some(
          (request) => request.blocking && isQuestionOpen(request),
        ) ?? false,
        shouldStop: () => !this.isActiveStreamGeneration(chatId, generation),
        onInactivity: async () => {
          if (!sessionId) {
            log.warn("Cannot abort inactive chat stream without a session ID", { chatId });
            return;
          }
          try {
            await backend.abortSession(sessionId);
          } catch (error) {
            log.warn("Failed to abort inactive chat session", {
              chatId,
              sessionId,
              error: String(error),
            });
          }
        },
        onEvent: (event) =>
          this.handleChatStreamEvent(chatId, backend, generation, streamState, event),
      });
      if (
        historyPromptContext
        && streamResult.lastEvent?.type === "prompt.complete"
        && streamResult.lastEvent.outcome === "completed"
        && !streamState.chat.state.interruptRequested
        && streamState.chat.state.status !== "interrupting"
      ) {
        try {
          await historyPromptContext.complete();
        } catch (error) {
          log.warn("Failed to clean up the completed chat history recovery export", {
            chatId,
            error: String(error),
          });
        }
      }
      canDrain ||= streamResult.lastEvent?.type === "prompt.complete";
      if (
        backend.harness.capabilities.adapter !== "acp"
        && this.isActiveStreamGeneration(chatId, generation)
        && streamResult.lastEvent?.type !== "prompt.complete"
        && streamResult.lastEvent?.type !== "error"
      ) throw new HarnessError("harness_transport_closed", "Native execution ended without a principal terminal signal.");
      if (streamResult.endedByInactivity) {
        const blocks = streamState.interpreter.flushActiveBlocks();
        await this.flushChatStreamBlocksAfterMetadataReload(chatId, streamState, blocks);
        if (blocks.length > 0) {
          streamState.interpreter.acknowledgeCheckpoint();
        }
        await this.completeChatAfterInactivity(chatId, generation, streamState);
      } else if (
        streamResult.lastEvent?.type !== "prompt.complete"
        && streamResult.lastEvent?.type !== "error"
      ) {
        const blocks = streamState.interpreter.flushActiveBlocks();
        await this.flushChatStreamBlocksAfterMetadataReload(chatId, streamState, blocks);
        if (blocks.length > 0) {
          streamState.interpreter.acknowledgeCheckpoint();
        }
      }
    } catch (error) {
      try {
        const blocks = streamState.interpreter.flushActiveBlocks();
        await this.flushChatStreamBlocksAfterMetadataReload(chatId, streamState, blocks);
        if (blocks.length > 0) {
          streamState.interpreter.acknowledgeCheckpoint();
        }
      } catch (flushError) {
        log.error("Failed to checkpoint chat transcript after stream failure", {
          chatId,
          error: String(flushError),
        });
      }
      if (this.shouldSuppressStreamError(
        chatId,
        generation,
        isAcpErrorCode(error, "acp_request_cancelled") ? "acp_request_cancelled" : undefined,
      )) {
        canDrain = true;
        const latestChat = await this.loadChatIfAvailable(chatId);
        const interruptedChat = latestChat
          ? {
            ...latestChat,
            state: {
              ...latestChat.state,
              messages: streamState.chat.state.messages,
              logs: streamState.chat.state.logs,
              toolCalls: streamState.chat.state.toolCalls,
            },
          }
          : streamState.chat;
        if (interruptedChat && (interruptedChat.state.status === "interrupting" || interruptedChat.state.interruptRequested)) {
          await this.completeInterruptedChat(
            interruptedChat,
            streamState.transcriptMemory,
            streamState.interpreter,
          );
        }
        return;
      }
      const errorChat = await this.loadChatIfAvailable(chatId);
      if (errorChat && this.isActiveStreamGeneration(chatId, generation)) {
        if (sessionId && backend.isConnected()) {
          try { await backend.abortSession(sessionId); } catch (abortError) {
            log.error("Failed to cancel chat after stream failure", { chatId, error: String(abortError) });
          }
        }
        await this.emitChatError(errorChat, error);
      }
    } finally {
      stopTranscriptSynchronization?.();
      historyPromptContext?.close();
      this.clearActiveStream(chatId, generation);
      if (canDrain) this.scheduleQueuedMessageDrain(chatId);
    }
  }

  private synchronizePersistedMessages(
    chatId: string,
    streamState: ChatStreamConsumptionState,
  ): () => void {
    return this.emitter.subscribe((event) => {
      if (event.type !== "chat.message" || event.chatId !== chatId || event.streamPosition) return;
      // Questions and steered inputs are persisted outside the provider's streaming loop.
      streamState.transcriptMemory.messages.upsert(event.message);
      const state = streamState.chat.state;
      streamState.chat = {
        ...streamState.chat,
        state: {
          ...state,
          messages: streamState.transcriptMemory.messages.values,
          lastActivityAt: state.lastActivityAt && state.lastActivityAt > event.timestamp
            ? state.lastActivityAt : event.timestamp,
          lastUserMessageAt: event.message.role === "user" && event.message.timestamp > (state.lastUserMessageAt ?? "")
            ? event.message.timestamp : state.lastUserMessageAt,
        },
      };
    });
  }

  private async completeChatAfterInactivity(
    chatId: string,
    generation: number,
    streamState: ChatStreamConsumptionState,
  ): Promise<void> {
    if (!this.isActiveStreamGeneration(chatId, generation)) {
      return;
    }
    if (!await this.reloadChatStreamState(chatId, streamState, true)) {
      return;
    }

    const chat = streamState.chat;
    if (chat.state.status === "interrupting" || chat.state.interruptRequested) {
      streamState.chat = await this.completeInterruptedChat(
        chat,
        streamState.transcriptMemory,
        streamState.interpreter,
      );
      this.clearActiveStream(chatId, generation);
      return;
    }
    if (!isChatBusyStatus(chat.state.status)) {
      return;
    }

    const inactivityMessage = "AI response stream ended after inactivity.";
    streamState.chat = await this.emitChatLog(
      chat,
      "info",
      "AI response stream ended after inactivity; treating the turn as complete",
      { logKind: "system", reason: "activity_timeout" },
      undefined,
      undefined,
      { memory: streamState.transcriptMemory },
    );

    const now = createTimestamp();
    const closedToolCalls: PersistedToolCall[] = [];
    streamState.interpreter.cancelRunningTools(now, inactivityMessage);
    const toolCalls = this.cancelInFlightToolCallsWithMemory(
      streamState.transcriptMemory,
      now,
      closedToolCalls,
      inactivityMessage,
    );
    const nextState = {
      ...streamState.chat.state,
      status: "idle" as const,
      startupStage: undefined,
      error: undefined,
      interruptRequested: false,
      activeMessageId: undefined,
      harness: {
        ...streamState.chat.state.harness,
        activeTurnAttachmentBytes: 0,
      },
      pendingPermissionRequests: this.resolvePendingPermissionRequests(
        streamState.chat.state.pendingPermissionRequests ?? [],
        {
          status: "cancelled",
          resolvedAt: now,
          error: inactivityMessage,
        },
      ),
      toolCalls,
      lastActivityAt: now,
    };
    streamState.chat = await this.updateState(streamState.chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, closedToolCalls.map((toolCall) => ({
        id: toolCall.id,
        kind: "tool",
        timestamp: toolCall.timestamp,
        payload: toolCall,
      }))),
    });
    this.clearActiveStream(chatId, generation);
  }

  private async reloadChatStreamState(
    chatId: string,
    streamState: ChatStreamConsumptionState,
    force = false,
  ): Promise<boolean> {
    const nowMs = Date.now();
    if (
      !force
      && nowMs - streamState.lastStatusReloadAt < CHAT_STREAM_STATUS_RELOAD_INTERVAL_MS
    ) {
      return true;
    }
    if (force) {
      const reloaded = await this.reloadChatStreamMetadata(chatId, streamState);
      streamState.lastStatusReloadAt = nowMs;
      return reloaded;
    }
    const latestControlState = await this.state.getChatStreamControlState(chatId);
    streamState.lastStatusReloadAt = nowMs;
    if (!latestControlState) {
      return false;
    }
    streamState.chat = {
      ...streamState.chat,
      state: {
        ...streamState.chat.state,
        status: latestControlState.status,
        interruptRequested: latestControlState.interruptRequested ? true : undefined,
      },
    };
    return true;
  }

  private async reloadChatStreamMetadata(
    chatId: string,
    streamState: ChatStreamConsumptionState,
  ): Promise<boolean> {
    const latestChat = await this.state.getChatSummary(chatId);
    if (!latestChat) {
      return false;
    }
    for (const message of projectQuestionMessages(
      streamState.transcriptMemory.messages.values,
      latestChat.state.harness?.questions,
    )) {
      streamState.transcriptMemory.messages.upsert(message);
    }
    streamState.chat = {
      ...latestChat,
      state: {
        ...latestChat.state,
        messages: streamState.transcriptMemory.messages.values,
        logs: streamState.chat.state.logs,
        toolCalls: streamState.chat.state.toolCalls,
        activeMessageId: streamState.chat.state.activeMessageId,
        lastActivityAt: streamState.chat.state.lastActivityAt ?? latestChat.state.lastActivityAt,
      },
    };
    return true;
  }

  private async flushChatStreamBlocksAfterMetadataReload(
    chatId: string,
    streamState: ChatStreamConsumptionState,
    blocks: AgentEventTranscriptBlock[],
  ): Promise<void> {
    if (blocks.length === 0 || streamState.deletionCheckpointed) {
      return;
    }
    if (!await this.reloadChatStreamMetadata(chatId, streamState)) {
      throw new Error(`Chat not found while flushing stream blocks: ${chatId}`);
    }
    await this.flushChatStreamBlocks(streamState, blocks);
  }

  private async handleChatStreamEvent(
    chatId: string,
    backend: Backend,
    generation: number,
    streamState: ChatStreamConsumptionState,
    event: AgentEvent,
  ): Promise<AgentStreamEventResult | void> {
    const forceMetadataReload =
      event.type !== "message.delta"
      && event.type !== "reasoning.delta"
      && event.type !== "tool.start"
      && event.type !== "tool.complete";
    if (!await this.reloadChatStreamState(
      chatId,
      streamState,
      forceMetadataReload,
    )) {
      return { stop: true };
    }
    if (streamState.deletionCheckpointed) return { stop: true };

    const now = createTimestamp();
    const isInterrupted =
      streamState.chat.state.status === "interrupting"
      || streamState.chat.state.interruptRequested;

    if (event.type === "message.start") {
      const transcriptResult = streamState.interpreter.handle(event);
      if (transcriptResult.flushedBlocks.length > 0) {
        await this.flushChatStreamBlocks(
          streamState,
          transcriptResult.flushedBlocks,
          now,
        );
      }
      if (isInterrupted) {
        return;
      }
      streamState.completedResponse = undefined;
      streamState.chat = await this.emitChatLog(
        streamState.chat,
        "agent",
        "AI started generating response",
        { logKind: "system" },
        undefined,
        undefined,
        { memory: streamState.transcriptMemory },
      );
      streamState.chat = await this.updateState(streamState.chat, {
        ...streamState.chat.state,
        activeMessageId: undefined,
        lastActivityAt: now,
      });
      if (transcriptResult.checkpointRequested) {
        streamState.interpreter.acknowledgeCheckpoint();
      }
      return;
    }

    if (
      isInterrupted
      && (
        event.type === "message.delta"
        || event.type === "reasoning.delta"
        || event.type === "tool.start"
        || event.type === "tool.complete"
        || event.type === "message.complete"
        || event.type === "prompt.complete"
        || event.type === "permission.asked"
      )
    ) {
      return;
    }

    const transcriptResult = streamState.interpreter.handle(event);
    if (
      !forceMetadataReload
      && (transcriptResult.flushedBlocks.length > 0 || transcriptResult.checkpointRequested)
      && !await this.reloadChatStreamMetadata(chatId, streamState)
    ) {
      return { stop: true };
    }
    switch (event.type) {
      case "user.message":
        break;

      case "message.delta": {
        if (transcriptResult.flushedBlocks.length > 0) {
          await this.flushChatStreamBlocks(
            streamState,
            transcriptResult.flushedBlocks,
            now,
          );
        }
        const delta = transcriptResult.responseDelta;
        if (delta) {
          streamState.chat = (
            await this.updateStreamingAssistantProgress(streamState.chat, {
              messageId: delta.messageId ?? null,
              content: delta.content,
              timestamp: delta.timestamp,
              activityTimestamp: now,
              delta: delta.delta,
              persist: transcriptResult.checkpointRequested,
              emitDelta: true,
              emitFullMessage: false,
            }, streamState.transcriptMemory)
          ).chat;
        }
        break;
      }

      case "reasoning.delta": {
        if (transcriptResult.flushedBlocks.length > 0) {
          await this.flushChatStreamBlocks(
            streamState,
            transcriptResult.flushedBlocks,
            now,
          );
        }
        const delta = transcriptResult.reasoningDelta;
        if (delta) {
          streamState.chat = await this.emitChatLog(streamState.chat, "agent", "AI reasoning...", {
            logKind: "reasoning",
            responseContent: delta.logContent,
          }, delta.logId, now, {
            delta: delta.delta,
            persist: transcriptResult.checkpointRequested,
            emitFull: delta.isFirstInBlock,
            memory: streamState.transcriptMemory,
          });
        }
        break;
      }

      case "tool.start":
      case "tool.complete":
        await this.flushChatStreamBlocks(
          streamState,
          transcriptResult.flushedBlocks,
          now,
        );
        if (transcriptResult.tool) {
          if (transcriptResult.tool.phase === "start") {
            streamState.chat = await this.appendToolCall(
              streamState.chat,
              transcriptResult.tool.tool,
              streamState.transcriptMemory,
            );
          } else {
            streamState.chat = await this.upsertToolCall(
              streamState.chat,
              transcriptResult.tool.tool,
              streamState.transcriptMemory,
            );
            this.scheduleToolImagePreview(streamState.chat, transcriptResult.tool.tool);
          }
        }
        break;

      case "session.status":
        if (
          event.status === "idle"
          && (streamState.chat.state.status === "interrupting" || streamState.chat.state.interruptRequested)
        ) {
          streamState.chat = await this.completeInterruptedChat(
            streamState.chat,
            streamState.transcriptMemory,
            streamState.interpreter,
          );
          streamState.interpreter.acknowledgeCheckpoint();
          if (!this.activeStreams.get(chatId)?.native) {
            this.clearActiveStream(chatId, generation);
            return { stop: true };
          }
          break;
        }
        break;

      case "message.complete":
        if (transcriptResult.flushedBlocks.length > 0) {
          await this.flushChatStreamBlocks(
            streamState,
            transcriptResult.flushedBlocks,
            now,
          );
        }
        const completedMessage = transcriptResult.completedMessage;
        if (completedMessage?.message.attachments?.length) {
          streamState.chat = (
            await this.updateStreamingAssistantProgress(streamState.chat, {
              messageId: completedMessage.message.id,
              content: completedMessage.message.content,
              timestamp: completedMessage.message.timestamp,
              activityTimestamp: now,
              attachments: completedMessage.message.attachments,
              persist: true,
              emitDelta: false,
              emitFullMessage: true,
            }, streamState.transcriptMemory)
          ).chat;
        }
        if (completedMessage && (completedMessage.responseLength > 0 || completedMessage.hadResponseBlock)) {
          streamState.chat = await this.emitChatLog(
            streamState.chat,
            "agent",
            "AI finished generating response",
            {
              logKind: "system",
              responseLength: completedMessage.responseLength,
            },
            undefined,
            undefined,
            { memory: streamState.transcriptMemory },
          );
        }
        streamState.interpreter.acknowledgeCheckpoint();
        streamState.completedResponse = completedMessage && completedMessage.responseLength > 0 ? {
          nativeMessageId: streamState.interpreter.state.currentMessageId,
          transcriptMessageId: completedMessage.message.id,
        } : undefined;
        break;

      case "prompt.complete":
        await this.flushChatStreamBlocks(
          streamState,
          streamState.interpreter.flushActiveBlocks(now),
          now,
        );
        if (
          event.outcome === "interrupted"
          || streamState.chat.state.interruptRequested
          || streamState.chat.state.status === "interrupting"
        ) {
          streamState.chat = await this.completeInterruptedChat(
            streamState.chat,
            streamState.transcriptMemory,
            streamState.interpreter,
          );
        } else {
          streamState.chat = await this.updateState(streamState.chat, {
            ...streamState.chat.state,
            status: "idle",
            error: undefined,
            startupStage: undefined,
            activeMessageId: undefined,
            interruptRequested: false,
            harness: {
              ...streamState.chat.state.harness,
              activeTurnAttachmentBytes: 0,
            },
            lastActivityAt: createTimestamp(),
          });
        }
        streamState.interpreter.acknowledgeCheckpoint();
        if (!this.activeStreams.get(chatId)?.native) {
          this.clearActiveStream(chatId, generation);
          return { stop: true };
        }
        break;

      case "request.error":
        log.warn("Native request failed while the chat execution remains open", {
          chatId, code: event.code, error: event.message,
        });
        streamState.chat = await this.emitChatLog(
          streamState.chat, "warn", event.message,
          { code: event.code, ...event.details },
          undefined, now, { memory: streamState.transcriptMemory },
        );
        streamState.chat = await this.updateState(streamState.chat, {
          ...streamState.chat.state,
          error: { message: event.message, code: event.code, timestamp: now },
          lastActivityAt: now,
        });
        break;

      case "error":
        if (this.shouldSuppressStreamError(chatId, generation, event.code)) {
          await this.flushChatStreamBlocks(
            streamState,
            transcriptResult.flushedBlocks,
            now,
          );
          const latestChat = await this.state.getChat(chatId);
          if (latestChat) {
            streamState.chat = {
              ...latestChat,
              state: {
                ...latestChat.state,
                messages: streamState.chat.state.messages,
                logs: streamState.chat.state.logs,
                toolCalls: streamState.chat.state.toolCalls,
              },
            };
          }
          if (streamState.chat.state.status === "interrupting" || streamState.chat.state.interruptRequested) {
            streamState.chat = await this.completeInterruptedChat(
              streamState.chat,
              streamState.transcriptMemory,
              streamState.interpreter,
            );
          }
          streamState.interpreter.acknowledgeCheckpoint();
          if (!this.activeStreams.get(chatId)?.native) {
            this.clearActiveStream(chatId, generation);
            return { stop: true };
          }
          break;
        }
        await this.flushChatStreamBlocks(
          streamState,
          transcriptResult.flushedBlocks,
          now,
        );
        streamState.chat = await this.emitChatError(
          streamState.chat,
          event.message,
          event.code,
          event.details,
        );
        streamState.interpreter.acknowledgeCheckpoint();
        if (!this.activeStreams.get(chatId)?.native) {
          this.clearActiveStream(chatId, generation);
          return { stop: true };
        }
        break;

      case "permission.asked":
        if (!this.permissionHandler) {
          streamState.chat = await this.emitChatError(
            streamState.chat,
            "Chat permission handler is not configured",
          );
          streamState.interpreter.acknowledgeCheckpoint();
          return { stop: true };
        }
        streamState.chat = await this.permissionHandler(streamState.chat, backend, {
          requestId: event.requestId,
          sessionId: event.sessionId,
          permission: event.permission,
          patterns: event.patterns,
          status: "pending",
          createdAt: now,
        });
        break;

      case "question.asked":
      case "question.resolved":
        await this.flushChatStreamBlocks(streamState, transcriptResult.flushedBlocks, now);
        if (!this.questionHandler) throw new HarnessError("harness_unsupported_feature", "Chat question handling is unavailable.");
        await this.questionHandler(streamState.chat, event,
          event.type === "question.asked" && event.responseMode === "message"
            && streamState.completedResponse?.nativeMessageId === event.scope.native?.messageId
            ? streamState.completedResponse?.transcriptMessageId : undefined);
        streamState.completedResponse = undefined;
        await this.reloadChatStreamMetadata(chatId, streamState);
        break;
    }

    if (transcriptResult.checkpointRequested) {
      streamState.interpreter.acknowledgeCheckpoint();
    }
  }

  private async flushChatStreamBlocks(
    streamState: ChatStreamConsumptionState,
    blocks: AgentEventTranscriptBlock[],
    activityTimestamp = createTimestamp(),
  ): Promise<void> {
    for (const block of blocks) {
      if (block.kind === "response" && block.messageId) {
        streamState.chat = (
          await this.updateStreamingAssistantProgress(streamState.chat, {
            messageId: block.messageId,
            content: block.content,
            timestamp: block.timestamp,
            activityTimestamp,
            delta: "",
            persist: true,
            emitDelta: false,
            emitFullMessage: true,
          }, streamState.transcriptMemory)
        ).chat;
      } else if (block.kind === "reasoning") {
        streamState.chat = await this.emitChatLog(streamState.chat, "agent", "AI reasoning...", {
          logKind: "reasoning",
          responseContent: block.logContent,
        }, block.logId, activityTimestamp, {
          persist: true,
          emitFull: true,
          memory: streamState.transcriptMemory,
        });
      }
    }
  }

  async recordSteeredMessage(chat: Chat, message: QueuedChatMessage, admission: HarnessInputAdmission): Promise<Chat> {
    const binding = chat.state.session?.binding;
    if (!binding) throw new Error("Steered input requires an owned conversation.");
    const transcriptMessage = message.transcriptMessage;
    return this.appendMessage(chat, (transcriptMessage && chat.state.messages.find(
      (entry) => entry.id === transcriptMessage.id,
    )) ?? transcriptMessage ?? {
      id: message.id, role: "user", content: message.content,
      attachments: message.attachments, timestamp: createTimestamp(),
    }, {
      queuedMessages: chat.state.queuedMessages?.filter((entry) => entry.id !== message.id),
      harness: {
        ...chat.state.harness,
        inputs: retainHarnessInputReceipt(chat.state.harness?.inputs ?? [], {
          conversation: binding, admission, submittedAt: message.createdAt,
        }),
      },
    });
  }

  private async appendMessage(
    chat: Chat,
    message: MessageData,
    updates: Partial<Chat["state"]> = { queuedMessages: chat.state.queuedMessages },
    expectedStatus?: ChatStatus,
  ): Promise<Chat> {
    const nextMessages = chat.state.messages.some((existing) => existing.id === message.id)
      ? chat.state.messages.map((existing) => existing.id === message.id ? message : existing)
      : [...chat.state.messages, message];
    const nextState = {
      ...chat.state,
      ...updates,
      messages: nextMessages,
      lastActivityAt: message.timestamp,
    };
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: message.id,
        kind: "message",
        timestamp: message.timestamp,
        payload: message,
      }]),
      expectedStatus,
    });
    this.emitMessage(updated, message);
    return updated;
  }

  private emitMessage(chat: Chat, message: MessageData): void {
    this.emitter.emit({
      type: "chat.message",
      chatId: chat.config.id,
      scope: chat.config.scope,
      message: chat.state.messages.find((entry) => entry.id === message.id) ?? message,
      timestamp: message.timestamp,
    });
  }

  private findMessage(
    chat: Chat,
    messageId?: string,
    memory?: ChatTranscriptMemory,
  ): MessageData | undefined {
    if (!messageId) {
      return undefined;
    }
    return memory
      ? memory.messages.get(messageId)
      : chat.state.messages.find((message) => message.id === messageId);
  }

  private createResponseSegmentMessageId(turnMessageId: string | null, segmentCount: number): string {
    if (!turnMessageId) {
      return `chat-assistant-${crypto.randomUUID()}`;
    }
    return segmentCount === 1 ? turnMessageId : `${turnMessageId}-segment-${segmentCount}`;
  }

  private getAssistantMessageTimestamp(chat: Chat, timestamp: string): string {
    const latestAnswer = (chat.state.harness?.questions ?? []).reduce(
      (latest, request) => Math.max(latest, request.transcript?.answerTimestamp
        ? Date.parse(request.transcript.answerTimestamp) : 0),
      0,
    );
    return Date.parse(timestamp) <= latestAnswer
      ? new Date(latestAnswer + 1).toISOString() : timestamp;
  }

  private async updateStreamingAssistantProgress(
    chat: Chat,
    {
      messageId,
      content,
      timestamp,
      activityTimestamp,
      attachments,
      delta,
      persist,
      emitDelta,
      emitFullMessage,
    }: {
      messageId: string | null;
      content: string;
      timestamp: string;
      activityTimestamp: string;
      attachments?: MessageData["attachments"];
      delta?: string;
      persist?: boolean;
      emitDelta?: boolean;
      emitFullMessage?: boolean;
    },
    memory?: ChatTranscriptMemory,
  ): Promise<{ chat: Chat; messageId: string }> {
    const shouldPersist = persist ?? true;
    const shouldEmitDelta = emitDelta ?? false;
    const shouldEmitFullMessage = emitFullMessage ?? true;
    const existingMessage = this.findMessage(chat, messageId ?? undefined, memory);
    const nextMessageId = existingMessage?.id
      ?? messageId
      ?? `chat-assistant-${crypto.randomUUID()}`;
    const assistantMessage: MessageData = {
      id: nextMessageId,
      role: "assistant",
      content,
      timestamp: existingMessage?.timestamp ?? this.getAssistantMessageTimestamp(chat, timestamp),
      question: existingMessage?.question,
      ...(attachments ?? existingMessage?.attachments
        ? { attachments: attachments ?? existingMessage?.attachments }
        : {}),
    };
    const nextMessages = memory
      ? (memory.messages.upsert(assistantMessage), memory.messages.values)
      : chat.state.messages.some((existing) => existing.id === assistantMessage.id)
        ? chat.state.messages.map((existing) => existing.id === assistantMessage.id ? assistantMessage : existing)
        : [...chat.state.messages, assistantMessage];
    const nextState = {
      ...chat.state,
      activeMessageId: nextMessageId,
      messages: nextMessages,
      lastActivityAt: activityTimestamp,
    };
    const transcriptUpserts: TranscriptChangeSet["upserts"] = [{
      id: assistantMessage.id,
      kind: "message" as const,
      timestamp: assistantMessage.timestamp,
      payload: assistantMessage,
    }];
    const streamPosition = memory?.version.change;
    const updated = shouldPersist
      ? await this.updateState(chat, nextState, {
        transcriptChanges: createTranscriptChangeSet(nextState, transcriptUpserts),
      })
      : { config: chat.config, state: nextState };
    if (shouldEmitDelta && delta !== undefined) {
      this.emitter.emit({
        type: "chat.message.delta",
        streamPosition,
        chatId: chat.config.id,
        scope: chat.config.scope,
        messageId: nextMessageId,
        role: "assistant",
        delta,
        baseLength: Math.max(0, content.length - delta.length),
        contentLength: content.length,
        messageTimestamp: assistantMessage.timestamp,
        timestamp: activityTimestamp,
      });
    }
    if (shouldEmitFullMessage) {
      this.emitter.emit({
        type: "chat.message",
        streamPosition,
        chatId: chat.config.id,
        scope: chat.config.scope,
        message: assistantMessage,
        timestamp: activityTimestamp,
      });
    }
    return {
      chat: updated,
      messageId: nextMessageId,
    };
  }

  async emitChatLog(
    chat: Chat,
    level: TaskLogEntry["level"],
    message: string,
    details?: Record<string, unknown>,
    id?: string,
    timestamp?: string,
    options: {
      delta?: string;
      persist?: boolean;
      emitFull?: boolean;
      memory?: ChatTranscriptMemory;
    } = {},
  ): Promise<Chat> {
    const shouldPersist = options.persist ?? true;
    const shouldEmitFull = options.emitFull ?? true;
    const existing = id
      ? options.memory
        ? options.memory.logs.get(id)
        : chat.state.logs.find((logEntry) => logEntry.id === id)
      : undefined;
    const activityTimestamp = timestamp ?? createTimestamp();
    const entry: TaskLogEntry = {
      id: id ?? `chat-log-${crypto.randomUUID()}`,
      level,
      message,
      details,
      timestamp: existing?.timestamp ?? activityTimestamp,
    };
    const logs = options.memory
      ? (options.memory.logs.upsert(entry), options.memory.logs.values)
      : chat.state.logs.findIndex((logEntry) => logEntry.id === entry.id) >= 0
        ? chat.state.logs.map((logEntry) => logEntry.id === entry.id ? entry : logEntry)
        : [...chat.state.logs, entry];
    const nextState = {
      ...chat.state,
      logs,
      lastActivityAt: activityTimestamp,
    };
    const streamPosition = options.memory?.version.change;
    const updated = shouldPersist
      ? await this.updateState(chat, nextState, {
        transcriptChanges: createTranscriptChangeSet(nextState, [{
          id: entry.id,
          kind: "log",
          timestamp: entry.timestamp,
          payload: entry,
        }]),
      })
      : { config: chat.config, state: nextState };
    if (options.delta !== undefined && id) {
      const responseContent = details?.["responseContent"];
      if (typeof responseContent === "string") {
        this.emitter.emit({
          type: "chat.log.delta",
          streamPosition,
          chatId: chat.config.id,
          scope: chat.config.scope,
          logId: id,
          level,
          message,
          logKind: typeof details?.["logKind"] === "string" ? details["logKind"] : "response",
          delta: options.delta,
          baseLength: Math.max(0, responseContent.length - options.delta.length),
          contentLength: responseContent.length,
          logTimestamp: entry.timestamp,
          timestamp: activityTimestamp,
        });
      }
    }
    if (shouldEmitFull) {
      this.emitter.emit({
        type: "chat.log",
        streamPosition,
        chatId: chat.config.id,
        scope: chat.config.scope,
        log: entry,
        timestamp: activityTimestamp,
      });
    }
    return updated;
  }

  private emitChatUpdated(chat: Chat): void {
    this.state.emitChatUpdated(chat);
  }

  private async appendToolCall(
    chat: Chat,
    tool: PersistedToolCall,
    memory?: ChatTranscriptMemory,
  ): Promise<Chat> {
    const toolCalls = memory
      ? (
        memory.toolCalls.upsert(tool),
        memory.toolCalls.values
      )
      : [...chat.state.toolCalls, tool];
    const nextState = {
      ...chat.state,
      toolCalls,
      lastActivityAt: tool.timestamp,
    };
    const streamPosition = memory?.version.change;
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: tool.id,
        kind: "tool",
        timestamp: tool.timestamp,
        payload: tool,
      }]),
      streaming: true,
    });
    this.emitter.emit({
      type: "chat.tool_call",
      streamPosition,
      chatId: chat.config.id,
      scope: chat.config.scope,
      tool,
      timestamp: tool.timestamp,
    });
    return updated;
  }

  private async upsertToolCall(
    chat: Chat,
    tool: PersistedToolCall,
    memory?: ChatTranscriptMemory,
  ): Promise<Chat> {
    const existing = memory
      ? memory.toolCalls.get(tool.id)
      : chat.state.toolCalls.find((candidate) => candidate.id === tool.id);
    const persistedTool = existing
      ? mergeToolCallRecord(existing, tool)
      : tool;
    const toolCalls = memory
      ? (memory.toolCalls.upsert(persistedTool), memory.toolCalls.values)
      : existing
        ? chat.state.toolCalls.map((candidate) => candidate.id === persistedTool.id ? persistedTool : candidate)
        : [...chat.state.toolCalls, tool];
    const nextState = {
      ...chat.state,
      toolCalls,
      lastActivityAt: tool.timestamp,
    };
    const streamPosition = memory?.version.change;
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: persistedTool.id,
        kind: "tool",
        timestamp: persistedTool.timestamp,
        payload: persistedTool,
      }]),
      streaming: true,
    });
    this.emitter.emit({
      type: "chat.tool_call",
      streamPosition,
      chatId: chat.config.id,
      scope: chat.config.scope,
      tool: persistedTool,
      timestamp: tool.timestamp,
    });
    return updated;
  }

  private async appendToolCallExtra(
    chat: Chat,
    toolId: string,
    extra: ToolCallExtra,
  ): Promise<Chat> {
    const timestamp = createTimestamp();
    const memory = this.activeStreams.get(chat.config.id)?.streamState?.transcriptMemory;
    const existingTool = memory
      ? memory.toolCalls.get(toolId)
      : chat.state.toolCalls.find((toolCall) => toolCall.id === toolId);
    if (!existingTool) {
      return chat;
    }
    const updatedTool = {
      ...existingTool,
      extras: upsertToolCallExtra(existingTool.extras, extra),
    };
    const toolCalls = memory
      ? (memory.toolCalls.upsert(updatedTool), memory.toolCalls.values)
      : chat.state.toolCalls.map((toolCall) => toolCall.id === toolId ? updatedTool : toolCall);
    const nextState = {
      ...chat.state,
      toolCalls,
      lastActivityAt: timestamp,
    };
    const streamPosition = memory?.version.change;
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: updatedTool.id,
        kind: "tool",
        timestamp: updatedTool.timestamp,
        payload: updatedTool,
      }]),
      streaming: true,
    });
    this.emitter.emit({
      type: "chat.tool_call.extra",
      streamPosition,
      chatId: chat.config.id,
      scope: chat.config.scope,
      toolId,
      extra,
      timestamp,
    });
    return updated;
  }

  private scheduleToolImagePreview(chat: Chat, tool: PersistedToolCall): void {
    const path = getImageViewToolPath(tool.name, tool.input);
    if (!path || !isWorkspaceChat(chat)) {
      return;
    }

    // Resolve previews in the background so the main chat stream is not blocked.
    void (async () => {
      try {
        const directory = chat.state.worktree?.worktreePath ?? chat.config.directory;
        const extra = await resolveToolCallImagePreview({
          workspaceId: getChatWorkspaceId(chat),
          directory,
          path,
          toolCallId: tool.id,
        });
        if (!extra) {
          return;
        }
        const latestChat = await this.loadChatIfAvailable(chat.config.id);
        if (!latestChat || !latestChat.state.toolCalls.some((toolCall) => toolCall.id === tool.id)) {
          return;
        }
        await this.appendToolCallExtra(latestChat, tool.id, extra);
      } catch (error) {
        log.debug("Skipping chat tool image preview generation", {
          chatId: chat.config.id,
          toolId: tool.id,
          error: String(error),
        });
      }
    })();
  }

  private async emitChatError(
    chat: Chat,
    error: unknown,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<Chat> {
    const message = typeof error === "string" ? error : getAcpErrorMessage(error);
    const errorCode = code ?? (isDomainError(error) ? error.code : undefined);
    log.error("Chat runtime error", { chatId: chat.config.id, error: message });
    const connectionFailed =
      isAcpSshTransportFailure(error)
      || isAcpSshTransportFailureMetadata(code, details);
    const errorChat = connectionFailed
      ? await this.state.updateState(chat, {
          ...chat.state,
          connectionStatus: "ssh_connection_failed",
        })
      : chat;
    return this.state.markChatError(errorChat, message, errorCode);
  }

  private async completeInterruptedChat(
    chat: Chat,
    memory?: ChatTranscriptMemory,
    interpreter?: AgentEventTranscriptInterpreter,
  ): Promise<Chat> {
    const now = createTimestamp();
    const cancelledToolCalls: PersistedToolCall[] = [];
    interpreter?.cancelRunningTools(now);
    const toolCalls = memory
      ? this.cancelInFlightToolCallsWithMemory(memory, now, cancelledToolCalls)
      : this.cancelInFlightToolCalls(chat.state.toolCalls, now);
    if (!memory) {
      cancelledToolCalls.push(...toolCalls.filter((toolCall, index) =>
        toolCall !== chat.state.toolCalls[index]
      ));
    }
    const nextState = {
      ...chat.state,
      status: "idle" as const,
      startupStage: undefined,
      error: undefined,
      interruptRequested: false,
      completedAt: undefined,
      activeMessageId: undefined,
      pendingPermissionRequests: this.resolvePendingPermissionRequests(chat.state.pendingPermissionRequests ?? [], {
        status: "cancelled",
        resolvedAt: now,
      }),
      harness: {
        ...chat.state.harness,
        activeTurnAttachmentBytes: 0,
        questions: closeOpenQuestions(chat.state.harness?.questions, "cancelled"),
      },
      toolCalls,
      lastActivityAt: now,
    };
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, cancelledToolCalls.map((toolCall) => ({
        id: toolCall.id,
        kind: "tool",
        timestamp: toolCall.timestamp,
        payload: toolCall,
      }))),
    });
    this.emitter.emit({
      type: "chat.interrupted",
      chatId: chat.config.id,
      scope: chat.config.scope,
      timestamp: now,
    });
    return updated;
  }

  private resolvePendingPermissionRequests(
    requests: ChatPermissionRequest[],
    updates: Pick<ChatPermissionRequest, "status" | "resolvedAt" | "decision" | "error">,
  ): ChatPermissionRequest[] {
    return requests.map((request) =>
      request.status === "pending" ? { ...request, ...updates } : request
    );
  }

  private cancelInFlightToolCalls(
    toolCalls: PersistedToolCall[],
    timestamp: string,
    output = "Cancelled by user.",
  ): PersistedToolCall[] {
    return toolCalls.map((toolCall) => {
      if (toolCall.status !== "pending" && toolCall.status !== "running") {
        return toolCall;
      }

      return {
        ...toolCall,
        status: "failed",
        output: toolCall.output ?? output,
        timestamp,
      };
    });
  }

  private cancelInFlightToolCallsWithMemory(
    memory: ChatTranscriptMemory,
    timestamp: string,
    cancelledToolCalls: PersistedToolCall[],
    output = "Cancelled by user.",
  ): PersistedToolCall[] {
    for (const toolCall of memory.toolCalls.values) {
      if (toolCall.status !== "pending" && toolCall.status !== "running") {
        continue;
      }

      const updatedTool: PersistedToolCall = {
        ...toolCall,
        status: "failed",
        output: toolCall.output ?? output,
        timestamp,
      };
      memory.toolCalls.upsert(updatedTool);
      cancelledToolCalls.push(updatedTool);
    }
    return memory.toolCalls.values;
  }

  private nextActiveStreamGeneration(chatId: string): number {
    const generation = (this.activeStreamGenerations.get(chatId) ?? 0) + 1;
    this.activeStreamGenerations.set(chatId, generation);
    return generation;
  }

  private isActiveStreamGeneration(chatId: string, generation: number): boolean {
    return this.activeStreams.get(chatId)?.generation === generation;
  }

  private clearActiveStream(chatId: string, generation: number): void {
    if (this.isActiveStreamGeneration(chatId, generation)) {
      this.activeStreams.get(chatId)?.stopTranscriptSynchronization?.();
      this.activeStreams.delete(chatId);
    }
  }

  private shouldSuppressStreamError(chatId: string, generation: number, code?: string): boolean {
    if (!this.isActiveStreamGeneration(chatId, generation)) {
      return true;
    }

    return code === "acp_request_cancelled";
  }

  private async updateState(
    chat: Chat,
    state: ChatState,
    options?: {
      transcriptChanges?: TranscriptChangeSet;
      expectedStatus?: ChatStatus;
      streaming?: boolean;
    },
  ): Promise<Chat> {
    return this.state.updateState(chat, state, options);
  }

  private assertChatIsAvailable(chat: Chat): void {
    if (isChatBusyStatus(chat.state.status)) {
      throw new ChatBusyError();
    }
  }

  private scheduleAutogeneratedChatName(
    chat: Chat,
    backend: Backend,
    message: string,
  ): void {
    if (!message) {
      return;
    }

    const previousUserMessages = chat.state.messages.filter((existingMessage) => existingMessage.role === "user");
    if (previousUserMessages.length !== 1) {
      return;
    }

    if (!isStandaloneChat(chat) || !isWorkspaceChat(chat)) {
      return;
    }

    // Naming starts only after the real prompt has been handed to ACP. It has
    // its own cleanup and error boundary so it cannot delay the chat turn.
    void this.generateAutogeneratedChatName(chat, backend, message);
  }

  private async generateAutogeneratedChatName(
    chat: Chat,
    backend: Backend,
    message: string,
  ): Promise<void> {
    const timer = createChatLatencyTimer();
    let tempSession: SessionInfo | null = null;
    let cleanupTempSession: (() => Promise<void>) | undefined;
    const directory = chat.state.worktree?.worktreePath
      ?? backend.getDirectory()
      ?? chat.config.directory;

    try {
      const workspaceId = getChatWorkspaceId(chat);
      const workspace = await this.state.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
      }

      const currentName = chat.config.name.trim();
      if (currentName && !isGeneratedChatName(currentName, workspace.name)) {
        return;
      }

      tempSession = await createTransientHarnessSession(backend, {
        title: "Chat Name Generation",
        directory,
      });
      const nameSession = tempSession;
      cleanupTempSession = createIdempotentAsyncOperation(() => cleanupTransientHarnessSession(backend, nameSession.id));
      const helperModel = await resolveEffectiveCheapModel({
        workspaceId,
        directory,
        model: chat.config.model,
        operation: "chat_name_generation",
      });
      const name = await timer.measure("name_generation", () => generateChatName({
        message,
        backend,
        sessionId: nameSession.id,
        model: helperModel,
        timeoutMs: DEFAULT_CHAT_NAME_TIMEOUT_MS,
        cancelSession: cleanupTempSession,
      }));

      const latest = await this.loadChatIfAvailable(chat.config.id);
      if (!latest) {
        return;
      }
      const latestUserMessages = latest.state.messages.filter((existingMessage) => existingMessage.role === "user");
      const latestWorkspace = isWorkspaceChat(latest)
        ? await this.state.getWorkspace(getChatWorkspaceId(latest))
        : null;
      if (
        !latestWorkspace
        || latestUserMessages.length !== 1
        || (latest.config.name.trim() && !isGeneratedChatName(latest.config.name, latestWorkspace.name))
      ) {
        return;
      }

      log.info("Generated chat name", {
        chatId: chat.config.id,
        name,
      });
      const updatedConfig: ChatConfig = {
        ...latest.config,
        name,
        updatedAt: createTimestamp(),
      };
      const updated = await this.state.updateConfig(latest.config.id, updatedConfig, {
        expectedName: latest.config.name,
      });
      if (updated) {
        this.state.emitChatUpdated(updated, updated.config.updatedAt);
      }
    } catch (error) {
      log.warn("Failed to generate chat name", {
        chatId: chat.config.id,
        error: String(error),
      });
    } finally {
      if (tempSession) {
        try {
          await cleanupTempSession?.();
        } catch (cleanupError) {
          log.warn("Failed to clean up temporary chat name generation session", {
            chatId: chat.config.id,
            sessionId: tempSession.id,
            error: String(cleanupError),
          });
        }
      }
      const timing = timer.complete();
      log.info("Chat name generation timing", {
        chatId: chat.config.id,
        totalMs: timing.totalMs,
        stages: timing.stages,
      });
    }
  }

  private async loadChatIfAvailable(chatId: string): Promise<Chat | null> {
    try {
      return await this.state.getChat(chatId);
    } catch (error) {
      if (isPersistenceError(error) && error.code === "database_not_initialized") {
        return null;
      }
      throw error;
    }
  }
}

function createStartupOperation(): StartupOperation {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    controller: new AbortController(),
    settled,
    resolveSettled,
    interrupted: false,
  };
}

function throwIfChatStartupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Chat startup was aborted");
  }
}

function isRecoverableChatStartupFailure(error: unknown): boolean {
  return (
    isAcpErrorCode(error, "acp_connection_timed_out")
    || isAcpErrorCode(error, "acp_transport_closed")
    || isAcpErrorCode(error, "acp_transport_unavailable")
    || isAcpErrorCode(error, "acp_request_timed_out")
  );
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
