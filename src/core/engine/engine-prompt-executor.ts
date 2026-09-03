/**
 * Prompt execution, stream ownership, and session-loss recovery for TaskEngine.
 */

import type { PersistedToolCall, TaskConfig, TaskState } from "@/shared/task";
import type { AgentEvent, PromptInput } from "../../backends/types";
import type { AgentEventTranscriptResult } from "../agent-event-transcript-interpreter";
import { createTimestamp, type LogLevel } from "@/shared/events";
import {
  type IterationContext,
  type SessionInterruptOptions,
  type TaskBackend,
  type TaskPromptBuildResult,
  type TaskPromptExecutionOptions,
  type TaskPromptExecutor,
  type TaskSessionLifecycle,
} from "./engine-types";
import {
  AgentStreamController,
  type AgentStreamHandle,
} from "../agent-stream-controller";
import {
  addSessionRecoveryBootstrap,
} from "./engine-prompt";
import {
  createAcpSessionNotFoundError,
  getAcpErrorMessage,
  isAcpErrorCode,
} from "../../backends/acp";
import { DEFAULT_TASK_CONFIG } from "@/shared/task";
import { log } from "@pablozaiden/webapp/server";

export interface TaskPromptExecutorOptions {
  backend: TaskBackend;
  session: TaskSessionLifecycle;
  config: TaskConfig;
  state: TaskState;
  getWorkingDirectory: () => string;
  emitLog: (level: LogLevel, message: string, details?: Record<string, unknown>) => string;
  updateState: (update: Partial<TaskState>) => void;
  processAgentEvent: (
    event: AgentEvent,
    ctx: IterationContext,
  ) => Promise<AgentEventTranscriptResult>;
  finalizeInFlightToolCalls: (
    timestamp: string,
    output: string,
  ) => PersistedToolCall[];
  triggerPersistence: () => Promise<void>;
  isAborted: () => boolean;
  isInjectionPending: () => boolean;
  resetIterationContextForRetry: (ctx: IterationContext) => void;
}

export class TaskPromptExecutorImpl implements TaskPromptExecutor {
  private readonly backend: TaskBackend;
  private readonly session: TaskSessionLifecycle;
  private readonly config: TaskConfig;
  private readonly state: TaskState;
  private readonly getWorkingDirectory: () => string;
  private readonly emitLog: TaskPromptExecutorOptions["emitLog"];
  private readonly updateState: TaskPromptExecutorOptions["updateState"];
  private readonly processAgentEvent: TaskPromptExecutorOptions["processAgentEvent"];
  private readonly finalizeInFlightToolCalls: TaskPromptExecutorOptions["finalizeInFlightToolCalls"];
  private readonly triggerPersistence: TaskPromptExecutorOptions["triggerPersistence"];
  private readonly isAborted: TaskPromptExecutorOptions["isAborted"];
  private readonly isInjectionPending: TaskPromptExecutorOptions["isInjectionPending"];
  private readonly resetIterationContextForRetry: TaskPromptExecutorOptions["resetIterationContextForRetry"];
  private currentStreamHandle: AgentStreamHandle | null = null;

  constructor(options: TaskPromptExecutorOptions) {
    this.backend = options.backend;
    this.session = options.session;
    this.config = options.config;
    this.state = options.state;
    this.getWorkingDirectory = options.getWorkingDirectory;
    this.emitLog = options.emitLog;
    this.updateState = options.updateState;
    this.processAgentEvent = options.processAgentEvent;
    this.finalizeInFlightToolCalls = options.finalizeInFlightToolCalls;
    this.triggerPersistence = options.triggerPersistence;
    this.isAborted = options.isAborted;
    this.isInjectionPending = options.isInjectionPending;
    this.resetIterationContextForRetry = options.resetIterationContextForRetry;
  }

  async execute(
    ctx: IterationContext,
    options: TaskPromptExecutionOptions,
  ): Promise<TaskPromptBuildResult> {
    await this.session.waitForInterrupt();

    if (!this.session.sessionId || !this.session.isConnected()) {
      this.emitLog("info", "AI session is unavailable - reconnecting before continuing", {
        hasSessionId: this.session.sessionId !== null,
        connected: this.session.isConnected(),
      });
      await this.session.ensureSession();
    }

    await this.session.handlePendingModelChange();

    log.debug("[TaskEngine] runIteration: Building prompt");
    this.emitLog("debug", "Building prompt for AI agent");
    let promptResult = options.buildPrompt();
    let prompt = promptResult.prompt;

    this.logPrompt(prompt);
    await this.triggerPersistence();

    let hasRetriedMissingSession = false;
    let completed = false;

    while (!completed) {
      const activeSessionId = this.session.sessionId;
      if (!activeSessionId) {
        throw new Error("No session ID");
      }

      const activityTimeoutSeconds =
        this.config.activityTimeoutSeconds ?? DEFAULT_TASK_CONFIG.activityTimeoutSeconds;
      const streamController = new AgentStreamController(this.backend);
      let streamHandle: AgentStreamHandle | null = null;

      try {
        log.debug("[TaskEngine] runIteration: Starting shared agent stream");
        this.emitLog("debug", "Subscribing to AI response stream");
        this.emitLog("info", "Sending prompt to AI agent...");
        streamHandle = streamController.start({
          sessionId: activeSessionId,
          prompt,
          activityTimeoutMs: activityTimeoutSeconds === null
            ? null
            : activityTimeoutSeconds * 1000,
        });
        this.currentStreamHandle = streamHandle;
        const started = await streamHandle.startPrompt();
        if (!started) {
          completed = true;
          continue;
        }

        log.debug("[TaskEngine] runIteration: Subscription established, got event stream");
        log.debug("[TaskEngine] runIteration: About to start event iteration task");
        let abortLogged = false;
        const streamResult = await streamHandle.consume({
          shouldStop: () => {
            if (!this.isAborted()) {
              return false;
            }
            if (!abortLogged) {
              abortLogged = true;
              if (this.isInjectionPending()) {
                this.emitLog("info", "Iteration interrupted for pending message injection");
              } else {
                this.emitLog("info", "Iteration aborted by user");
              }
            }
            return true;
          },
          onEvent: async (event) => {
            log.trace("[TaskEngine] runIteration: Received event", { type: event.type });
            this.updateState({ lastActivityAt: createTimestamp() });
            const transcriptResult = await this.processAgentEvent(event, ctx);
            if (transcriptResult.checkpointRequested) {
              await this.triggerPersistence();
              ctx.transcript.acknowledgeCheckpoint();
            }

            if (event.type === "error" && event.code === "acp_session_not_found") {
              throw createAcpSessionNotFoundError(activeSessionId, {
                details: {
                  ...(event.details ?? {}),
                  eventMessage: event.message,
                  sessionId: activeSessionId,
                },
              });
            }

            if (event.type === "message.complete" || event.type === "error") {
              this.emitLog("debug", `Breaking out of event stream: ${event.type}`);
            }
          },
        });
        if (streamResult.endedByInactivity) {
          const inactivityMessage = "AI response stream ended after inactivity.";
          const finalizedToolCalls = this.finalizeInFlightToolCalls(
            createTimestamp(),
            inactivityMessage,
          );
          this.emitLog("info", "AI response stream ended after inactivity; treating the turn as complete", {
            activityTimeoutSeconds,
            sessionId: activeSessionId,
          });
          if (finalizedToolCalls.length > 0) {
            await this.triggerPersistence();
          }
        }

        completed = true;
      } catch (error) {
        if (!hasRetriedMissingSession && isAcpErrorCode(error, "acp_session_not_found")) {
          hasRetriedMissingSession = true;
          const message = getAcpErrorMessage(error);
          this.emitLog(
            "warn",
            "Session not found during prompt execution - recreating session and retrying once",
            {
              sessionId: activeSessionId,
              error: message,
            },
          );
          await this.session.recreateAfterLoss(message);
          if (promptResult.promptMode === "direct_user") {
            prompt = addSessionRecoveryBootstrap(prompt, {
              originalGoal: this.config.prompt,
              workingDirectory: this.getWorkingDirectory(),
              workingBranch: this.state.git?.workingBranch,
            });
            promptResult = { ...promptResult, prompt };
          }
          this.session.consumeSessionRecovery();
          this.resetIterationContextForRetry(ctx);
          continue;
        }

        throw error;
      } finally {
        streamHandle?.close();
        if (this.currentStreamHandle === streamHandle) {
          this.currentStreamHandle = null;
        }
      }
    }

    this.emitLog("debug", "Exited event stream task", {
      outcome: ctx.outcome,
      error: ctx.error,
    });
    return promptResult;
  }

  async interrupt(options: SessionInterruptOptions): Promise<void> {
    if (options.closeStream !== false) {
      this.currentStreamHandle?.close();
    }
    await this.session.interruptSession(options);
  }

  private logPrompt(prompt: PromptInput): void {
    log.debug("[TaskEngine] runIteration: Prompt details", {
      partsCount: prompt.parts.length,
      model: prompt.model ? `${prompt.model.providerID}/${prompt.model.modelID}` : "default",
      textLength: prompt.parts[0]?.type === "text" ? prompt.parts[0].text.length : 0,
      textPreview: prompt.parts[0]?.type === "text" ? prompt.parts[0].text.slice(0, 200) : "",
    });

    const fullPromptText = prompt.parts
      .map((part) => {
        if (part.type === "image") {
          return `[image:${part.mimeType}]`;
        }
        if (part.type === "resource") {
          return `[resource:${part.resource.mimeType ?? "application/octet-stream"}]`;
        }
        return part.text;
      })
      .join("\n---\n");
    this.emitLog("debug", `[Prompt] ${fullPromptText}`);
  }
}
