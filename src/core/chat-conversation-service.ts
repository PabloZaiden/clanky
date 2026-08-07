/**
 * ACP prompt execution and persisted conversation materialization.
 */

import {
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
  isAcpSshTransportFailure,
  isAcpSshTransportFailureMetadata,
} from "../backends/acp";
import type {
  AgentEvent,
  Backend,
  PromptInput,
  SessionReplayEvent,
} from "../backends/types";
import type {
  Chat,
  ChatConfig,
  ChatPermissionRequest,
  ChatState,
  MessageData,
  PersistedMessage,
  PersistedToolCall,
  SessionInfo,
  TaskLogEntry,
  TranscriptChangeSet,
} from "@/shared";
import { createTranscriptChangeSet } from "@/shared";
import {
  ChatBusyError,
  isChatBusyStatus,
  isSshServerChat,
  isStandaloneChat,
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
import {
  AgentEventTranscriptInterpreter,
  type AgentEventTranscriptBlock,
} from "./agent-event-transcript-interpreter";
import { createLogger } from "@pablozaiden/webapp/server";
import { resolveEffectiveCheapModel } from "./cheap-model";
import { generateChatName } from "../utils/name-generator";
import { resolveToolCallImagePreview, getImageViewToolPath } from "./tool-call-image-preview";
import { mergeToolCallRecord, upsertToolCallExtra, type ToolCallExtra } from "@/shared/tool-call";
import { isPersistenceError } from "../persistence/errors";
import { isGeneratedChatName } from "./chat-name";
import type {
  ChatConversationPort,
  ChatSessionPort,
  ChatStatePort,
  NormalizedChatMessageInput,
} from "./chat-service-contracts";
import { buildPromptParts } from "../backends/prompt-parts";

const log = createLogger("chat-conversation-service");
const DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const CHAT_STREAM_STATUS_RELOAD_INTERVAL_MS = 500;

interface ActiveChatStream {
  handle: AgentStreamHandle;
  generation: number;
  completion: Promise<void>;
}

interface ChatTranscriptMemory {
  messages: TranscriptMemoryIndex<PersistedMessage>;
  logs: TranscriptMemoryIndex<TaskLogEntry>;
  toolCalls: TranscriptMemoryIndex<PersistedToolCall>;
}

function createChatTranscriptMemory(state: ChatState): ChatTranscriptMemory {
  const messages = state.messages ?? [];
  const logs = state.logs ?? [];
  const toolCalls = state.toolCalls ?? [];
  return {
    messages: new TranscriptMemoryIndex(messages),
    logs: new TranscriptMemoryIndex(logs),
    toolCalls: new TranscriptMemoryIndex(toolCalls),
  };
}

interface ChatStreamConsumptionState {
  chat: Chat;
  transcriptMemory: ChatTranscriptMemory;
  interpreter: AgentEventTranscriptInterpreter;
  lastStatusReloadAt: number;
}

export type ChatPermissionHandler = (
  chat: Chat,
  backend: Backend,
  request: ChatPermissionRequest,
) => Promise<Chat>;

export interface ChatConversationServiceDependencies {
  state: ChatStatePort;
  session: ChatSessionPort;
  emitter?: SimpleEventEmitter<ChatEvent>;
  scheduleQueuedMessageDrain?: (chatId: string) => void;
  permissionHandler?: ChatPermissionHandler;
}

export class ChatConversationService implements ChatConversationPort {
  private readonly activeStreams = new Map<string, ActiveChatStream>();
  private readonly activeStreamGenerations = new Map<string, number>();
  private readonly state: ChatStatePort;
  private readonly session: ChatSessionPort;
  private readonly emitter: SimpleEventEmitter<ChatEvent>;
  private readonly scheduleQueuedMessageDrain: (chatId: string) => void;
  private permissionHandler: ChatPermissionHandler | undefined;

  constructor(dependencies: ChatConversationServiceDependencies) {
    this.state = dependencies.state;
    this.session = dependencies.session;
    this.emitter = dependencies.emitter ?? chatEventEmitter;
    this.scheduleQueuedMessageDrain = dependencies.scheduleQueuedMessageDrain ?? (() => {});
    this.permissionHandler = dependencies.permissionHandler;
  }

  setPermissionHandler(handler: ChatPermissionHandler): void {
    this.permissionHandler = handler;
  }

  async dispatchMessage(
    chat: Chat,
    input: NormalizedChatMessageInput,
    options: { clearQueuedMessages?: boolean } = {},
  ): Promise<Chat> {
    this.assertChatIsAvailable(chat);

    const backend = await this.session.ensureBackendConnected(chat);
    const sessionChat = await this.session.ensureSession(chat, backend, { recreateIfMissing: true });
    if (!sessionChat.state.session?.id) {
      throw new Error("Failed to establish chat session");
    }

    await this.session.configureSessionModel(backend, sessionChat.state.session.id, sessionChat.config.model.modelID);

    const userMessage: MessageData = {
      id: `chat-user-${crypto.randomUUID()}`,
      role: "user",
      content: input.message,
      attachments: input.attachments.length > 0 ? input.attachments : undefined,
      timestamp: createTimestamp(),
    };

    let current = await this.appendMessage(sessionChat, userMessage, {
      queuedMessages: options.clearQueuedMessages ? [] : sessionChat.state.queuedMessages,
    });
    if (options.clearQueuedMessages) {
      this.emitChatUpdated(current);
    }
    current = await this.updateState(current, {
      ...current.state,
      status: "starting",
      error: undefined,
      completedAt: undefined,
      activeMessageId: undefined,
      interruptRequested: false,
      lastActivityAt: createTimestamp(),
    });
    current = await this.renameAutogeneratedChatFromFirstMessage(current, backend, input.message);

    const prompt: PromptInput = {
      parts: buildPromptParts(input.message, input.attachments),
      model: current.config.model,
    };

    const sessionId = current.state.session?.id;
    if (!sessionId) {
      throw new Error("Failed to establish chat session");
    }
    try {
      return await this.startActivePrompt(current, backend, sessionId, prompt);
    } catch (error) {
      await this.emitChatError(current, error);
      throw error;
    }
  }

  async waitForChatIdle(chatId: string, timeoutMs = DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS): Promise<Chat> {
    const startedAt = Date.now();
    while (true) {
      const summary = await this.state.getChatSummary(chatId);
      if (!summary) {
        throw new Error(`Chat not found: ${chatId}`);
      }
      if (!this.activeStreams.has(chatId) && !isChatBusyStatus(summary.state.status)) {
        return await this.state.getChat(chatId) ?? summary;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for chat to become idle: ${chatId}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async interruptChat(chatId: string, reason?: string): Promise<Chat | null> {
    const chat = await this.state.getChat(chatId);
    if (!chat) {
      return null;
    }

    if (!chat.state.session?.id) {
      return chat;
    }

    const backend = await this.session.ensureBackendConnected(chat);
    await this.updateState(chat, {
      ...chat.state,
      status: "interrupting",
      interruptRequested: true,
      lastActivityAt: createTimestamp(),
    });

    const activeStream = this.activeStreams.get(chatId);
    if (activeStream) {
      this.closeActiveStream(chatId);
    }

    try {
      await backend.abortSession(chat.state.session.id);
    } catch (error) {
      log.warn("Failed to abort chat session during interrupt", {
        chatId,
        sessionId: chat.state.session.id,
        error: String(error),
      });
    }

    if (activeStream) {
      try {
        await this.session.disconnectChat(chatId);
      } catch (error) {
        log.warn("Failed to disconnect chat backend during interrupt", {
          chatId,
          error: String(error),
        });
      }
    }

    if (activeStream) {
      await activeStream.completion;
    }
    const latestChat = await this.state.getChat(chatId);
    if (!latestChat) {
      return null;
    }
    if (reason) {
      log.info("Chat interrupted by user request", { chatId, reason });
    }
    const completed = activeStream
      || latestChat.state.status === "interrupting"
      || latestChat.state.interruptRequested
      ? await this.completeInterruptedChat(latestChat)
      : latestChat;
    this.scheduleQueuedMessageDrain(chatId);
    return completed;
  }

  closeActiveStream(chatId: string): void {
    this.activeStreams.get(chatId)?.handle.close();
    this.activeStreams.delete(chatId);
    this.activeStreamGenerations.delete(chatId);
  }

  hasActiveStream(chatId: string): boolean {
    return this.activeStreams.has(chatId);
  }

  buildImportedReplayState(
    chat: Chat,
    events: SessionReplayEvent[],
    sessionId: string,
  ): ChatState {
    const messages: MessageData[] = [];
    const logs: TaskLogEntry[] = [];
    const toolCalls: PersistedToolCall[] = [];
    const toolInputs = new Map<string, unknown>();
    let pendingText: { kind: "user" | "assistant" | "reasoning"; content: string } | null = null;
    let lastActivityAt = createTimestamp();

    const flushPendingText = (): void => {
      if (!pendingText || pendingText.content.length === 0) {
        pendingText = null;
        return;
      }

      const timestamp = createTimestamp();
      lastActivityAt = timestamp;
      if (pendingText.kind === "user") {
        messages.push({
          id: `chat-user-${crypto.randomUUID()}`,
          role: "user",
          content: pendingText.content,
          timestamp,
        });
      } else if (pendingText.kind === "assistant") {
        const messageId = `chat-assistant-${crypto.randomUUID()}`;
        messages.push({
          id: messageId,
          role: "assistant",
          content: pendingText.content,
          timestamp,
        });
        logs.push({
          id: `chat-log-${crypto.randomUUID()}`,
          level: "agent",
          message: "Imported AI response",
          details: {
            logKind: "response",
            responseContent: pendingText.content,
          },
          timestamp,
        });
      } else {
        logs.push({
          id: `chat-log-${crypto.randomUUID()}`,
          level: "agent",
          message: "Imported AI reasoning",
          details: {
            logKind: "reasoning",
            responseContent: pendingText.content,
          },
          timestamp,
        });
      }

      pendingText = null;
    };

    const appendText = (kind: "user" | "assistant" | "reasoning", content: string): void => {
      if (pendingText?.kind === kind) {
        pendingText.content += content;
        return;
      }
      flushPendingText();
      pendingText = { kind, content };
    };

    for (const event of events) {
      switch (event.type) {
        case "user.message":
          appendText("user", event.content);
          break;
        case "assistant.message":
          appendText("assistant", event.content);
          break;
        case "reasoning":
          appendText("reasoning", event.content);
          break;
        case "tool.start": {
          flushPendingText();
          const timestamp = createTimestamp();
          lastActivityAt = timestamp;
          const toolId = event.toolCallId ?? `chat-tool-${crypto.randomUUID()}`;
          const toolKey = event.toolCallId ?? event.toolName;
          toolInputs.set(toolKey, event.input);
          toolCalls.push({
            id: toolId,
            name: event.toolName,
            input: event.input,
            status: "running",
            timestamp,
          });
          logs.push({
            id: `chat-log-${crypto.randomUUID()}`,
            level: "agent",
            message: `Imported tool call: ${event.toolName}`,
            details: {
              logKind: "tool",
              toolCallId: toolId,
              toolName: event.toolName,
            },
            timestamp,
          });
          break;
        }
        case "tool.complete": {
          flushPendingText();
          const timestamp = createTimestamp();
          lastActivityAt = timestamp;
          const existingIndex = event.toolCallId
            ? toolCalls.findIndex((toolCall) => toolCall.id === event.toolCallId)
            : toolCalls.findLastIndex((toolCall) =>
              toolCall.name === event.toolName && toolCall.status === "running"
            );
          const toolKey = event.toolCallId ?? event.toolName;
          const completedInput = event.input ?? (
            existingIndex >= 0 ? toolCalls[existingIndex]?.input : undefined
          ) ?? toolInputs.get(toolKey);
          toolInputs.set(toolKey, completedInput);
          const completedTool: PersistedToolCall = {
            id: event.toolCallId ?? (existingIndex >= 0 ? toolCalls[existingIndex]!.id : `chat-tool-${crypto.randomUUID()}`),
            name: event.toolName,
            input: completedInput,
            output: event.output,
            status: "completed",
            timestamp,
          };
          if (existingIndex >= 0) {
            toolCalls[existingIndex] = mergeToolCallRecord(toolCalls[existingIndex]!, completedTool);
          } else {
            toolCalls.push(completedTool);
          }
          logs.push({
            id: `chat-log-${crypto.randomUUID()}`,
            level: "agent",
            message: `Imported tool result: ${event.toolName}`,
            details: {
              logKind: "tool",
              toolCallId: completedTool.id,
              toolName: event.toolName,
            },
            timestamp,
          });
          break;
        }
      }
    }
    flushPendingText();

    const startedAt = chat.state.startedAt ?? createTimestamp();
    return {
      ...chat.state,
      status: "idle",
      session: { id: sessionId },
      startedAt,
      completedAt: undefined,
      lastActivityAt,
      error: undefined,
      messages,
      logs,
      toolCalls,
      activeMessageId: undefined,
      interruptRequested: false,
      pendingPermissionRequests: [],
    };
  }

  private async startActivePrompt(
    chat: Chat,
    backend: Backend,
    sessionId: string,
    prompt: PromptInput,
  ): Promise<Chat> {
    const streamController = new AgentStreamController(backend);
    const handle = streamController.start({
      sessionId,
      prompt,
      activityTimeoutMs: DEFAULT_CHAT_ACTIVITY_TIMEOUT_MS,
    });
    const generation = this.nextActiveStreamGeneration(chat.config.id);
    const activeStream: ActiveChatStream = {
      handle,
      generation,
      completion: Promise.resolve(),
    };
    this.activeStreams.set(chat.config.id, activeStream);
    try {
      const streamingChat = await this.updateState(chat, {
        ...chat.state,
        status: "streaming",
        error: undefined,
        interruptRequested: false,
        completedAt: undefined,
        lastActivityAt: createTimestamp(),
      });
      const started = await handle.startPrompt();
      if (!started) {
        this.clearActiveStream(chat.config.id, generation);
        return await this.state.getChat(chat.config.id) ?? chat;
      }
      activeStream.completion = this.consumeEventStream(chat.config.id, backend, handle, generation, streamingChat);
      return streamingChat;
    } catch (error) {
      this.clearActiveStream(chat.config.id, generation);
      handle.close();
      throw error;
    }
  }

  private createChatStreamState(initialChat: Chat): ChatStreamConsumptionState {
    const transcriptMemory = createChatTranscriptMemory(initialChat.state);
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
  ): Promise<void> {
    const streamState = this.createChatStreamState(initialChat);

    try {
      const streamResult = await handle.consume({
        shouldStop: () => !this.isActiveStreamGeneration(chatId, generation),
        onEvent: (event) =>
          this.handleChatStreamEvent(chatId, backend, generation, streamState, event),
      });
      if (
        streamResult.lastEvent?.type !== "message.complete"
        && streamResult.lastEvent?.type !== "error"
      ) {
        const blocks = streamState.interpreter.flushActiveBlocks();
        await this.flushChatStreamBlocks(streamState, blocks);
        if (blocks.length > 0) {
          streamState.interpreter.acknowledgeCheckpoint();
        }
      }
    } catch (error) {
      try {
        const blocks = streamState.interpreter.flushActiveBlocks();
        await this.flushChatStreamBlocks(streamState, blocks);
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
        await this.emitChatError(errorChat, error);
      }
    } finally {
      this.clearActiveStream(chatId, generation);
      this.scheduleQueuedMessageDrain(chatId);
    }
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
    const latestChat = await this.state.getChatSummary(chatId);
    streamState.lastStatusReloadAt = nowMs;
    if (!latestChat) {
      return false;
    }
    streamState.chat = {
      ...latestChat,
      state: {
        ...latestChat.state,
        messages: streamState.chat.state.messages,
        logs: streamState.chat.state.logs,
        toolCalls: streamState.chat.state.toolCalls,
        activeMessageId: streamState.chat.state.activeMessageId,
        lastActivityAt: streamState.chat.state.lastActivityAt ?? latestChat.state.lastActivityAt,
      },
    };
    if (latestChat.state.status === "interrupting" || latestChat.state.interruptRequested) {
      streamState.chat = {
        ...streamState.chat,
        state: {
          ...streamState.chat.state,
          status: latestChat.state.status,
          interruptRequested: latestChat.state.interruptRequested,
        },
      };
    }
    return true;
  }

  private async handleChatStreamEvent(
    chatId: string,
    backend: Backend,
    generation: number,
    streamState: ChatStreamConsumptionState,
    event: AgentEvent,
  ): Promise<AgentStreamEventResult | void> {
    if (!await this.reloadChatStreamState(
      chatId,
      streamState,
      event.type !== "message.delta" && event.type !== "reasoning.delta",
    )) {
      return { stop: true };
    }

    const now = createTimestamp();
    const isInterrupted =
      streamState.chat.state.status === "interrupting"
      || streamState.chat.state.interruptRequested;

    if (event.type === "message.start") {
      const transcriptResult = streamState.interpreter.handle(event);
      if (isInterrupted) {
        return;
      }
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
        || event.type === "permission.asked"
      )
    ) {
      return;
    }

    const transcriptResult = streamState.interpreter.handle(event);
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
              responseLogId: delta.logId,
              responseLogContent: delta.logContent,
              timestamp: delta.timestamp,
              activityTimestamp: now,
              delta: delta.delta,
              persist: transcriptResult.checkpointRequested,
              emitDelta: true,
              emitFullMessage: false,
              updateResponseLog: false,
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
          this.clearActiveStream(chatId, generation);
          return { stop: true };
        }
        if (event.status === "idle") {
          streamState.chat = await this.updateState(streamState.chat, {
            ...streamState.chat.state,
            status: "idle",
            interruptRequested: false,
            lastActivityAt: now,
          });
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
        streamState.chat = await this.emitChatLog(
          streamState.chat,
          "agent",
          "AI finished generating response",
          {
            logKind: "system",
            responseLength: transcriptResult.completedMessage?.responseLength
              ?? streamState.interpreter.state.totalResponseLength,
          },
          undefined,
          undefined,
          { memory: streamState.transcriptMemory },
        );
        if (streamState.chat.state.interruptRequested || streamState.chat.state.status === "interrupting") {
          streamState.chat = await this.completeInterruptedChat(
            streamState.chat,
            streamState.transcriptMemory,
            streamState.interpreter,
          );
        } else {
          streamState.chat = await this.updateState(streamState.chat, {
            ...streamState.chat.state,
            status: "idle",
            activeMessageId: undefined,
            interruptRequested: false,
            lastActivityAt: createTimestamp(),
          });
        }
        streamState.interpreter.acknowledgeCheckpoint();
        this.clearActiveStream(chatId, generation);
        return { stop: true };

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
          this.clearActiveStream(chatId, generation);
          return { stop: true };
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
        this.clearActiveStream(chatId, generation);
        return { stop: true };

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
        streamState.chat = await this.emitChatError(
          streamState.chat,
          `Interactive question requires a UI response: ${event.questions.map((question) => question.question).join(" | ")}`,
        );
        streamState.interpreter.acknowledgeCheckpoint();
        return { stop: true };
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
            responseLogId: block.logId,
            responseLogContent: block.logContent,
            timestamp: block.timestamp,
            activityTimestamp,
            delta: "",
            persist: true,
            emitDelta: false,
            emitFullMessage: true,
            updateResponseLog: false,
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

  private async appendMessage(
    chat: Chat,
    message: MessageData,
    updates: Pick<Chat["state"], "queuedMessages"> = { queuedMessages: chat.state.queuedMessages },
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
    });
    this.emitter.emit({
      type: "chat.message",
      chatId: chat.config.id,
      scope: chat.config.scope,
      message,
      timestamp: message.timestamp,
    });
    return updated;
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

  private async updateStreamingAssistantProgress(
    chat: Chat,
    {
      messageId,
      content,
      responseLogId,
      responseLogContent,
      timestamp,
      activityTimestamp,
      delta,
      persist,
      emitDelta,
      emitFullMessage,
      updateResponseLog,
    }: {
      messageId: string | null;
      content: string;
      responseLogId: string | null;
      responseLogContent: string;
      timestamp: string;
      activityTimestamp: string;
      delta?: string;
      persist?: boolean;
      emitDelta?: boolean;
      emitFullMessage?: boolean;
      updateResponseLog?: boolean;
    },
    memory?: ChatTranscriptMemory,
  ): Promise<{ chat: Chat; messageId: string; responseLogId: string }> {
    const shouldPersist = persist ?? true;
    const shouldEmitDelta = emitDelta ?? false;
    const shouldEmitFullMessage = emitFullMessage ?? true;
    const shouldUpdateResponseLog = updateResponseLog ?? true;
    const existingMessage = this.findMessage(chat, messageId ?? undefined, memory);
    const existingLog = shouldUpdateResponseLog && responseLogId
      ? memory
        ? memory.logs.get(responseLogId)
        : chat.state.logs.find((logEntry) => logEntry.id === responseLogId)
      : undefined;
    const nextMessageId = existingMessage?.id
      ?? messageId
      ?? `chat-assistant-${crypto.randomUUID()}`;
    const assistantMessage: MessageData = {
      id: nextMessageId,
      role: "assistant",
      content,
      timestamp: existingMessage?.timestamp ?? timestamp,
    };
    const responseLog: TaskLogEntry = {
      id: responseLogId ?? `chat-log-${crypto.randomUUID()}`,
      level: "agent",
      message: "AI generating response...",
      details: {
        logKind: "response",
        responseContent: responseLogContent,
      },
      timestamp: existingLog?.timestamp ?? timestamp,
    };
    const nextMessages = memory
      ? (memory.messages.upsert(assistantMessage), memory.messages.values)
      : chat.state.messages.some((existing) => existing.id === assistantMessage.id)
        ? chat.state.messages.map((existing) => existing.id === assistantMessage.id ? assistantMessage : existing)
        : [...chat.state.messages, assistantMessage];
    const nextLogs = shouldUpdateResponseLog
      ? memory
        ? (memory.logs.upsert(responseLog), memory.logs.values)
        : existingLog
          ? chat.state.logs.map((logEntry) => logEntry.id === responseLog.id ? responseLog : logEntry)
          : [...chat.state.logs, responseLog]
      : chat.state.logs;
    const nextState = {
      ...chat.state,
      activeMessageId: nextMessageId,
      messages: nextMessages,
      logs: nextLogs,
      lastActivityAt: activityTimestamp,
    };
    const transcriptUpserts: TranscriptChangeSet["upserts"] = [{
      id: assistantMessage.id,
      kind: "message" as const,
      timestamp: assistantMessage.timestamp,
      payload: assistantMessage,
    }];
    if (shouldUpdateResponseLog) {
      transcriptUpserts.push({
        id: responseLog.id,
        kind: "log" as const,
        timestamp: responseLog.timestamp,
        payload: responseLog,
      });
    }
    const updated = shouldPersist
      ? await this.updateState(chat, nextState, {
        transcriptChanges: createTranscriptChangeSet(nextState, transcriptUpserts),
      })
      : { config: chat.config, state: nextState };
    if (shouldEmitDelta && delta !== undefined) {
      this.emitter.emit({
        type: "chat.message.delta",
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
        chatId: chat.config.id,
        scope: chat.config.scope,
        message: assistantMessage,
        timestamp: activityTimestamp,
      });
    }
    if (shouldUpdateResponseLog) {
      this.emitter.emit({
        type: "chat.log",
        chatId: chat.config.id,
        scope: chat.config.scope,
        log: responseLog,
        timestamp: activityTimestamp,
      });
    }
    return {
      chat: updated,
      messageId: nextMessageId,
      responseLogId: responseLog.id,
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
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: tool.id,
        kind: "tool",
        timestamp: tool.timestamp,
        payload: tool,
      }]),
    });
    this.emitter.emit({
      type: "chat.tool_call",
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
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: persistedTool.id,
        kind: "tool",
        timestamp: persistedTool.timestamp,
        payload: persistedTool,
      }]),
    });
    this.emitter.emit({
      type: "chat.tool_call",
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
    timestamp = createTimestamp(),
    memory?: ChatTranscriptMemory,
  ): Promise<Chat> {
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
    const updated = await this.updateState(chat, nextState, {
      transcriptChanges: createTranscriptChangeSet(nextState, [{
        id: updatedTool.id,
        kind: "tool",
        timestamp: updatedTool.timestamp,
        payload: updatedTool,
      }]),
    });
    this.emitter.emit({
      type: "chat.tool_call.extra",
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
    if (!path) {
      return;
    }

    // Resolve previews in the background so the main chat stream is not blocked.
    void (async () => {
      try {
        const directory = chat.state.worktree?.worktreePath ?? chat.config.directory;
        const extra = await resolveToolCallImagePreview({
          workspaceId: chat.config.workspaceId,
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
    const errorCode = code ?? (isAcpError(error) ? error.code : undefined);
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
      error: undefined,
      interruptRequested: false,
      completedAt: undefined,
      activeMessageId: undefined,
      pendingPermissionRequests: this.resolvePendingPermissionRequests(chat.state.pendingPermissionRequests ?? [], {
        status: "cancelled",
        resolvedAt: now,
      }),
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

  private cancelInFlightToolCalls(toolCalls: PersistedToolCall[], timestamp: string): PersistedToolCall[] {
    return toolCalls.map((toolCall) => {
      if (toolCall.status !== "pending" && toolCall.status !== "running") {
        return toolCall;
      }

      return {
        ...toolCall,
        status: "failed",
        output: toolCall.output ?? "Cancelled by user.",
        timestamp,
      };
    });
  }

  private cancelInFlightToolCallsWithMemory(
    memory: ChatTranscriptMemory,
    timestamp: string,
    cancelledToolCalls: PersistedToolCall[],
  ): PersistedToolCall[] {
    for (const toolCall of memory.toolCalls.values) {
      if (toolCall.status !== "pending" && toolCall.status !== "running") {
        continue;
      }

      const updatedTool: PersistedToolCall = {
        ...toolCall,
        status: "failed",
        output: toolCall.output ?? "Cancelled by user.",
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
    options?: { transcriptChanges?: TranscriptChangeSet },
  ): Promise<Chat> {
    return this.state.updateState(chat, state, options);
  }

  private assertChatIsAvailable(chat: Chat): void {
    if (isChatBusyStatus(chat.state.status)) {
      throw new ChatBusyError();
    }
  }

  private async renameAutogeneratedChatFromFirstMessage(
    chat: Chat,
    backend: Backend,
    message: string,
  ): Promise<Chat> {
    if (!message) {
      return chat;
    }

    const previousUserMessages = chat.state.messages.filter((existingMessage) => existingMessage.role === "user");
    if (previousUserMessages.length !== 1) {
      return chat;
    }

    if (!isStandaloneChat(chat) || isSshServerChat(chat)) {
      return chat;
    }

    const workspace = await this.state.getWorkspace(chat.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chat.config.workspaceId}`);
    }

    const currentName = chat.config.name.trim();
    if (currentName && !isGeneratedChatName(currentName, workspace.name)) {
      return chat;
    }

    let tempSession: SessionInfo | null = null;

    try {
      tempSession = await backend.createSession({
        title: "Chat Name Generation",
        directory: chat.config.directory,
      });
      const helperModel = await resolveEffectiveCheapModel({
        workspaceId: chat.config.workspaceId,
        directory: chat.config.directory,
        model: chat.config.model,
        operation: "chat_name_generation",
      });
      const name = await generateChatName({
        message,
        backend,
        sessionId: tempSession.id,
        model: helperModel,
      });
      log.info("Generated chat name", {
        chatId: chat.config.id,
        name,
      });
      const updatedConfig: ChatConfig = {
        ...chat.config,
        name,
        updatedAt: createTimestamp(),
      };
      const updated = await this.state.updateConfig(chat.config.id, updatedConfig);
      if (!updated) {
        return chat;
      }
      this.state.emitChatUpdated(updated, updated.config.updatedAt);
      return {
        ...updated,
        state: chat.state,
      };
    } catch (error) {
      log.warn("Failed to generate chat name", {
        chatId: chat.config.id,
        error: String(error),
      });
      return chat;
    } finally {
      if (tempSession) {
        try {
          await backend.abortSession(tempSession.id);
        } catch (cleanupError) {
          log.warn("Failed to clean up temporary chat name generation session", {
            chatId: chat.config.id,
            sessionId: tempSession.id,
            error: String(cleanupError),
          });
        }
      }
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
