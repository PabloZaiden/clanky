/**
 * ACP prompt execution and persisted conversation materialization.
 */

import {
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
} from "../backends/acp";
import type {
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
  type AgentStreamHandle,
  getAgentStreamTextByteLength,
} from "./agent-stream-controller";
import { chatEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { TranscriptMemoryIndex } from "./transcript-memory-index";
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
  runningToolIdsByName: Map<string, string[]>;
}

function createChatTranscriptMemory(state: ChatState): ChatTranscriptMemory {
  const messages = state.messages ?? [];
  const logs = state.logs ?? [];
  const toolCalls = state.toolCalls ?? [];
  const runningToolIdsByName = new Map<string, string[]>();
  for (const toolCall of toolCalls) {
    if (toolCall.status !== "running") {
      continue;
    }
    const runningToolIds = runningToolIdsByName.get(toolCall.name) ?? [];
    runningToolIds.push(toolCall.id);
    runningToolIdsByName.set(toolCall.name, runningToolIds);
  }
  return {
    messages: new TranscriptMemoryIndex(messages),
    logs: new TranscriptMemoryIndex(logs),
    toolCalls: new TranscriptMemoryIndex(toolCalls),
    runningToolIdsByName,
  };
}

function updateRunningToolIndex(
  memory: ChatTranscriptMemory,
  previous: PersistedToolCall | undefined,
  next: PersistedToolCall,
): void {
  if (previous?.status === "running" && next.status !== "running") {
    const runningToolIds = memory.runningToolIdsByName.get(previous.name);
    const index = runningToolIds?.lastIndexOf(previous.id) ?? -1;
    if (index >= 0) {
      runningToolIds!.splice(index, 1);
    }
  }
  if (next.status === "running" && previous?.status !== "running") {
    const runningToolIds = memory.runningToolIdsByName.get(next.name) ?? [];
    runningToolIds.push(next.id);
    memory.runningToolIdsByName.set(next.name, runningToolIds);
  }
}

function getLatestRunningTool(
  memory: ChatTranscriptMemory,
  name: string,
): PersistedToolCall | undefined {
  const runningToolIds = memory.runningToolIdsByName.get(name);
  if (!runningToolIds) {
    return undefined;
  }
  while (runningToolIds.length > 0) {
    const toolId = runningToolIds[runningToolIds.length - 1]!;
    const tool = memory.toolCalls.get(toolId);
    if (tool?.status === "running") {
      return tool;
    }
    runningToolIds.pop();
  }
  return undefined;
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

  private async consumeEventStream(
    chatId: string,
    backend: Backend,
    handle: AgentStreamHandle,
    generation: number,
    initialChat: Chat,
  ): Promise<void> {
    let chat: Chat = initialChat;
    const transcriptMemory = createChatTranscriptMemory(initialChat.state);

    let currentTurnMessageId: string | null = null;
    let currentResponseMessageId: string | null = null;
    let currentResponseContent = "";
    let currentResponseLogId: string | null = null;
    let currentResponseLogContent = "";
    let currentResponseTimestamp: string | null = null;
    let totalResponseLength = 0;
    let responseSegmentCount = 0;
    let currentReasoningLogId: string | null = null;
    let currentReasoningLogContent = "";
    let currentStreamBlockKind: "response" | "reasoning" | null = null;
    let lastStatusReloadAt = 0;
    const streamCheckpointPolicy = new AgentStreamCheckpointPolicy();
    const toolInputs = new Map<string, unknown>();
    const reloadInterruptStateIfNeeded = async (force = false): Promise<boolean> => {
      const nowMs = Date.now();
      if (!force && nowMs - lastStatusReloadAt < CHAT_STREAM_STATUS_RELOAD_INTERVAL_MS) {
        return true;
      }
      const latestChat = await this.state.getChatSummary(chatId);
      lastStatusReloadAt = nowMs;
      if (!latestChat) {
        return false;
      }
      chat = {
        ...latestChat,
        state: {
          ...latestChat.state,
          messages: chat.state.messages,
          logs: chat.state.logs,
          toolCalls: chat.state.toolCalls,
          activeMessageId: chat.state.activeMessageId,
          lastActivityAt: chat.state.lastActivityAt ?? latestChat.state.lastActivityAt,
        },
      };
      if (latestChat.state.status === "interrupting" || latestChat.state.interruptRequested) {
        chat = {
          ...chat,
          state: {
            ...chat.state,
            status: latestChat.state.status,
            interruptRequested: latestChat.state.interruptRequested,
          },
        };
      }
      return true;
    };
    const flushActiveStreamBlock = async (activityTimestamp = createTimestamp()): Promise<void> => {
      if (
        currentStreamBlockKind === "response"
        && currentResponseMessageId
        && currentResponseTimestamp
      ) {
        ({
          chat,
          messageId: currentResponseMessageId,
          responseLogId: currentResponseLogId,
        } = await this.updateStreamingAssistantProgress(chat, {
          messageId: currentResponseMessageId,
          content: currentResponseContent,
          responseLogId: currentResponseLogId,
          responseLogContent: currentResponseLogContent,
          timestamp: currentResponseTimestamp,
          activityTimestamp,
          delta: "",
          persist: true,
          emitDelta: false,
          emitFullMessage: true,
          updateResponseLog: false,
        }, transcriptMemory));
        streamCheckpointPolicy.markCheckpoint();
      } else if (currentStreamBlockKind === "reasoning" && currentReasoningLogId) {
        chat = await this.emitChatLog(chat, "agent", "AI reasoning...", {
          logKind: "reasoning",
          responseContent: currentReasoningLogContent,
        }, currentReasoningLogId, activityTimestamp, {
          persist: true,
          emitFull: true,
          memory: transcriptMemory,
        });
        streamCheckpointPolicy.markCheckpoint();
      }
    };
    const resetActiveStreamBlock = (): void => {
      currentResponseMessageId = null;
      currentResponseContent = "";
      currentResponseLogId = null;
      currentResponseLogContent = "";
      currentResponseTimestamp = null;
      currentReasoningLogId = null;
      currentReasoningLogContent = "";
      currentStreamBlockKind = null;
    };
    const resetCurrentTurnStreamState = (): void => {
      currentTurnMessageId = null;
      totalResponseLength = 0;
      responseSegmentCount = 0;
      resetActiveStreamBlock();
    };

    try {
      const streamResult = await handle.consume({
        shouldStop: () => !this.isActiveStreamGeneration(chatId, generation),
        onEvent: async (event) => {
        if (!await reloadInterruptStateIfNeeded(event.type !== "message.delta" && event.type !== "reasoning.delta")) {
          return { stop: true };
        }

        const now = createTimestamp();
        const isInterrupted = chat.state.status === "interrupting" || chat.state.interruptRequested;

        switch (event.type) {
          case "user.message":
            break;

          case "message.start":
            resetCurrentTurnStreamState();
            currentTurnMessageId = event.messageId;
            if (isInterrupted) {
              break;
            }
            chat = await this.emitChatLog(chat, "agent", "AI started generating response", { logKind: "system" }, undefined, undefined, {
              memory: transcriptMemory,
            });
            chat = await this.updateState(chat, {
              ...chat.state,
              activeMessageId: undefined,
              lastActivityAt: now,
            });
            break;

          case "message.delta":
            if (isInterrupted) {
              break;
            }
            if (currentStreamBlockKind !== "response") {
              responseSegmentCount += 1;
              currentResponseMessageId = this.createResponseSegmentMessageId(currentTurnMessageId, responseSegmentCount);
              currentResponseContent = "";
              currentResponseLogId = `chat-log-${crypto.randomUUID()}`;
              currentResponseLogContent = "";
              currentResponseTimestamp = now;
              currentStreamBlockKind = "response";
            }
            currentResponseContent += event.content;
            currentResponseLogContent += event.content;
            totalResponseLength += event.content.length;
            const persistResponseProgress = streamCheckpointPolicy.recordText(
              getAgentStreamTextByteLength(event.content),
            );
            ({
              chat,
              messageId: currentResponseMessageId,
              responseLogId: currentResponseLogId,
            } = await this.updateStreamingAssistantProgress(chat, {
              messageId: currentResponseMessageId,
              content: currentResponseContent,
              responseLogId: currentResponseLogId,
              responseLogContent: currentResponseLogContent,
              timestamp: currentResponseTimestamp ?? now,
              activityTimestamp: now,
              delta: event.content,
              persist: persistResponseProgress,
              emitDelta: true,
              emitFullMessage: false,
              updateResponseLog: false,
            }, transcriptMemory));
            if (persistResponseProgress) {
              streamCheckpointPolicy.markCheckpoint();
            }
            break;

          case "reasoning.delta":
            if (isInterrupted) {
              break;
            }
            const isFirstReasoningDelta = currentStreamBlockKind !== "reasoning";
            if (currentStreamBlockKind !== "reasoning") {
              currentReasoningLogId = `chat-log-${crypto.randomUUID()}`;
              currentReasoningLogContent = "";
              currentStreamBlockKind = "reasoning";
            }
            currentReasoningLogContent += event.content;
            const persistReasoningProgress = streamCheckpointPolicy.recordText(
              getAgentStreamTextByteLength(event.content),
            );
            chat = await this.emitChatLog(chat, "agent", "AI reasoning...", {
              logKind: "reasoning",
              responseContent: currentReasoningLogContent,
            }, currentReasoningLogId ?? undefined, now, {
              delta: event.content,
              persist: persistReasoningProgress,
              emitFull: isFirstReasoningDelta,
              memory: transcriptMemory,
            });
            if (persistReasoningProgress) {
              streamCheckpointPolicy.markCheckpoint();
            }
            break;

          case "tool.start": {
            if (isInterrupted) {
              break;
            }
            await flushActiveStreamBlock(now);
            resetActiveStreamBlock();
            const toolId = event.toolCallId ?? `chat-tool-${crypto.randomUUID()}`;
            const toolKey = event.toolCallId ?? event.toolName;
            toolInputs.set(toolKey, event.input);
            chat = await this.appendToolCall(chat, {
              id: toolId,
              name: event.toolName,
              input: event.input,
              status: "running",
              timestamp: now,
            }, transcriptMemory);
            break;
          }

          case "tool.complete": {
            if (isInterrupted) {
              break;
            }
            await flushActiveStreamBlock(now);
            resetActiveStreamBlock();
            const toolName = event.toolName;
            const toolCallId = event.toolCallId;
            const toolKey = toolCallId ?? toolName;
            const existing = toolCallId
              ? transcriptMemory.toolCalls.get(toolCallId)
              : getLatestRunningTool(transcriptMemory, toolName);
            const completedInput = event.input ?? existing?.input ?? toolInputs.get(toolKey);
            const completedToolId = toolCallId ?? existing?.id ?? `chat-tool-${crypto.randomUUID()}`;
            toolInputs.set(toolKey, completedInput);
            chat = await this.upsertToolCall(chat, {
              id: completedToolId,
              name: toolName,
              input: completedInput,
              output: event.output,
              status: "completed",
              timestamp: now,
            }, transcriptMemory);
            this.scheduleToolImagePreview(chat, {
              id: completedToolId,
              name: toolName,
              input: completedInput,
              output: event.output,
              status: "completed",
              timestamp: now,
            });
            break;
          }

          case "session.status":
            if (event.status === "idle" && (chat.state.status === "interrupting" || chat.state.interruptRequested)) {
              chat = await this.completeInterruptedChat(chat, transcriptMemory);
              this.clearActiveStream(chatId, generation);
              return { stop: true };
            } else if (event.status === "idle") {
              chat = await this.updateState(chat, {
                ...chat.state,
                status: "idle",
                interruptRequested: false,
                lastActivityAt: now,
              });
            }
            break;

          case "message.complete": {
            if (isInterrupted) {
              chat = await this.completeInterruptedChat(chat, transcriptMemory);
              this.clearActiveStream(chatId, generation);
              return { stop: true };
            }
            await flushActiveStreamBlock(now);
            const completedResponseLength = event.content.length > 0
              ? event.content.length
              : totalResponseLength;
            chat = await this.emitChatLog(chat, "agent", "AI finished generating response", {
              logKind: "system",
              responseLength: completedResponseLength,
            }, undefined, undefined, { memory: transcriptMemory });
            if (responseSegmentCount === 0 && event.content.length > 0) {
              responseSegmentCount += 1;
              currentResponseMessageId = this.createResponseSegmentMessageId(currentTurnMessageId, responseSegmentCount);
              currentResponseContent = event.content;
              currentResponseLogId = `chat-log-${crypto.randomUUID()}`;
              currentResponseLogContent = event.content;
              currentResponseTimestamp = now;
              totalResponseLength = event.content.length;
              currentStreamBlockKind = "response";
              ({
                chat,
                messageId: currentResponseMessageId,
                responseLogId: currentResponseLogId,
              } = await this.updateStreamingAssistantProgress(chat, {
                messageId: currentResponseMessageId,
                content: currentResponseContent,
                responseLogId: currentResponseLogId,
                responseLogContent: currentResponseLogContent,
                timestamp: currentResponseTimestamp,
                activityTimestamp: now,
                delta: event.content,
                persist: true,
                emitDelta: false,
                emitFullMessage: true,
                updateResponseLog: false,
              }, transcriptMemory));
              streamCheckpointPolicy.markCheckpoint();
            }
            if (chat.state.interruptRequested || chat.state.status === "interrupting") {
              chat = await this.completeInterruptedChat(chat, transcriptMemory);
            } else {
              const completionTimestamp = createTimestamp();
              chat = await this.updateState(chat, {
                ...chat.state,
                status: "idle",
                activeMessageId: undefined,
                interruptRequested: false,
                lastActivityAt: completionTimestamp,
              });
            }
            this.clearActiveStream(chatId, generation);
            return { stop: true };
          }

          case "error":
            if (this.shouldSuppressStreamError(chatId, generation, event.code)) {
              await flushActiveStreamBlock(now);
              const latestChat = await this.state.getChat(chatId);
              if (latestChat) {
                chat = {
                  ...latestChat,
                  state: {
                    ...latestChat.state,
                    messages: chat.state.messages,
                    logs: chat.state.logs,
                    toolCalls: chat.state.toolCalls,
                  },
                };
              }
              if (chat.state.status === "interrupting" || chat.state.interruptRequested) {
                await this.completeInterruptedChat(chat, transcriptMemory);
              }
              this.clearActiveStream(chatId, generation);
              return { stop: true };
            }
            await flushActiveStreamBlock(now);
            await this.emitChatError(chat, event.message, event.code);
            this.clearActiveStream(chatId, generation);
            return { stop: true };

          case "permission.asked":
            if (isInterrupted) {
              break;
            }
            if (!this.permissionHandler) {
              await this.emitChatError(chat, "Chat permission handler is not configured");
              return { stop: true };
            }
            chat = await this.permissionHandler(chat, backend, {
              requestId: event.requestId,
              sessionId: event.sessionId,
              permission: event.permission,
              patterns: event.patterns,
              status: "pending",
              createdAt: now,
            });
            break;

          case "question.asked":
            await this.emitChatError(
              chat,
              `Interactive question requires a UI response: ${event.questions.map((question) => question.question).join(" | ")}`,
            );
            return { stop: true };
        }

        },
      });
      if (
        streamResult.lastEvent?.type !== "message.complete"
        && streamResult.lastEvent?.type !== "error"
      ) {
        await flushActiveStreamBlock();
      }
    } catch (error) {
      try {
        await flushActiveStreamBlock();
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
              messages: chat.state.messages,
              logs: chat.state.logs,
              toolCalls: chat.state.toolCalls,
            },
          }
          : chat;
        if (interruptedChat && (interruptedChat.state.status === "interrupting" || interruptedChat.state.interruptRequested)) {
          await this.completeInterruptedChat(interruptedChat, transcriptMemory);
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
        updateRunningToolIndex(memory, memory.toolCalls.get(tool.id), tool),
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
      ? (updateRunningToolIndex(memory, existing, persistedTool), memory.toolCalls.upsert(persistedTool), memory.toolCalls.values)
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

  private async emitChatError(chat: Chat, error: unknown, code?: string): Promise<Chat> {
    const message = typeof error === "string" ? error : getAcpErrorMessage(error);
    const errorCode = code ?? (isAcpError(error) ? error.code : undefined);
    log.error("Chat runtime error", { chatId: chat.config.id, error: message });
    return this.state.markChatError(chat, message, errorCode);
  }

  private async completeInterruptedChat(chat: Chat, memory?: ChatTranscriptMemory): Promise<Chat> {
    const now = createTimestamp();
    const cancelledToolCalls: PersistedToolCall[] = [];
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
      updateRunningToolIndex(memory, toolCall, updatedTool);
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
