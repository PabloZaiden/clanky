import type { Automation, AutomationRun, AutomationRunTrigger } from "@/shared/automation";
import { isAutomationCodeEnabled } from "@/shared/automation";
import type { Chat, ChatEvent } from "@/shared";
import { hasRemoteChatContinuity } from "@/shared/chat";
import { createTranscriptChangeSet } from "@/shared";
import type { MessageAttachment } from "@/shared/message-attachments";
import { createTimestamp } from "@/shared/events";
import { DomainError, isDomainError } from "../domain/domain-error";
import { chatManager } from "./chat-manager";
import {
  loadAutomation,
  saveAutomation,
  saveAutomationRun,
} from "../persistence/automations";
import { createLogger } from "@pablozaiden/webapp/server";
import { automationEventEmitter, chatEventEmitter } from "./event-emitter";
import { executeDeterministicAutomation } from "./deterministic-automation-runtime";
import { DeterministicAutomationOutput } from "./deterministic-automation-output";
import { MAX_PERSISTED_LOGS } from "./conversation-limits";
import { AutomationRunStreamPersistence } from "./automation-run-stream-persistence";
import { getWorkspace } from "../persistence/workspaces";
import { assertWorktreesAllowed } from "./workspace-capabilities";
import { captureWorkspaceExecutionContext, runWithWorkspaceExecutionContext, requireExecutionOwnerUser, runWithExecutionOwner } from "../context/user-context";

const log = createLogger("automation-runner");
const REMOTE_RUN_SUSPENDED = Symbol("remote-run-suspended");
const REMOTE_RUN_INTERRUPTED = Symbol("remote-run-interrupted");

function isAutomationChatEvent(event: ChatEvent): boolean {
  if ("scope" in event) {
    return event.scope === "automation";
  }
  if (event.type === "chat.created") {
    return event.config.scope === "automation";
  }
  if (event.type === "chat.updated") {
    return event.chat.config.scope === "automation";
  }
  return false;
}

function createRunFromAutomation(
  automation: Automation,
  trigger: AutomationRunTrigger,
  scheduledFor: string,
  attachments: MessageAttachment[] = [],
): AutomationRun {
  const now = createTimestamp();
  return {
    id: crypto.randomUUID(),
    automationId: automation.config.id,
    status: "scheduled",
    trigger,
    scheduledFor,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    attachments,
    configSnapshot: {
      name: automation.config.name,
      workspaceId: automation.config.workspaceId,
      directory: automation.config.directory,
      prompt: automation.config.prompt,
      code: automation.config.code,
      model: automation.config.model,
      baseBranch: automation.config.baseBranch,
      repositoryBases: automation.config.repositoryBases,
      useWorktree: automation.config.useWorktree,
      schedule: automation.config.schedule,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function mergeRunLogs(chatLogs: AutomationRun["logs"], outputLogs: AutomationRun["logs"]): AutomationRun["logs"] {
  const byId = new Map<string, AutomationRun["logs"][number]>();
  for (const logEntry of [...chatLogs, ...outputLogs]) {
    byId.set(logEntry.id, logEntry);
  }
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_PERSISTED_LOGS);
}

export class AutomationRunner {
  private readonly activeRuns = new Map<string, Promise<AutomationRun>>();
  private readonly activeRunControllers = new Map<string, {
    controller: AbortController; observer: AbortController; owner: ReturnType<typeof requireExecutionOwnerUser>;
  }>();
  private readonly activeRunPersistences = new Map<string, AutomationRunStreamPersistence>();

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  private trackRun(runId: string, promise: Promise<AutomationRun>): void {
    this.activeRuns.set(runId, promise);
    void promise.then(() => this.activeRuns.delete(runId), (error: unknown) => {
      this.activeRuns.delete(runId);
      log.error("Automation execution could not be finalized", { runId, error: String(error) });
    });
  }

  async resumeRemoteRun(automation: Automation, run: AutomationRun): Promise<boolean> {
    if (this.activeRuns.has(run.id)) return true;
    if (!run.chatId || run.status !== "running" || automation.state.activeRunId !== run.id
      || isAutomationCodeEnabled(run.configSnapshot)) return false;
    const chat = await chatManager.getChat(run.chatId);
    if (!chat || !hasRemoteChatContinuity(chat) || !chat.state.lastUserMessageAt) return false;
    const execution = captureWorkspaceExecutionContext(run.configSnapshot.workspaceId);
    this.trackRun(run.id, runWithWorkspaceExecutionContext(execution, () => this.executeRun(automation, run, chat)));
    return true;
  }

  async suspendRemoteRuns(): Promise<void> {
    await Promise.all([...this.activeRunControllers].map(([runId, { observer, owner }]) =>
      runWithExecutionOwner(owner, async () => {
        const run = this.activeRunPersistences.get(runId)?.currentRun;
        if (!run?.chatId || isAutomationCodeEnabled(run.configSnapshot)) return;
        const chat = await chatManager.getChatSummary(run.chatId);
        if (!chat || !hasRemoteChatContinuity(chat)) return;
        observer.abort(REMOTE_RUN_SUSPENDED);
        await this.activeRuns.get(runId);
      })));
  }

  getLiveTranscript(runId: string) {
    return this.activeRunPersistences.get(runId)?.liveTranscript;
  }

  async runAutomation(
    automation: Automation,
    trigger: AutomationRunTrigger,
    options: {
      scheduledFor?: string;
      attachments?: MessageAttachment[];
    } = {},
  ): Promise<AutomationRun> {
    const run = await this.startAutomationRun(automation, trigger, options);
    const activeRun = this.activeRuns.get(run.id);
    if (!activeRun) {
      return run;
    }
    return activeRun;
  }

  async startAutomationRun(
    automation: Automation,
    trigger: AutomationRunTrigger,
    options: {
      scheduledFor?: string;
      attachments?: MessageAttachment[];
    } = {},
  ): Promise<AutomationRun> {
    if (automation.config.useWorktree) {
      const workspace = await getWorkspace(automation.config.workspaceId);
      if (!workspace) {
        throw new DomainError("workspace_not_found", "Workspace not found", {
          details: { workspaceId: automation.config.workspaceId },
        });
      }
      assertWorktreesAllowed(workspace);
    }
    const scheduledFor = options.scheduledFor ?? createTimestamp();
    let run = createRunFromAutomation(automation, trigger, scheduledFor, options.attachments);
    await saveAutomationRun(run, {
      transcriptChanges: {
        ...createTranscriptChangeSet(run),
        revision: `${run.updatedAt}:0`,
      },
    });
    automationEventEmitter.emit({
      type: "automation.run.scheduled",
      automationId: automation.config.id,
      automationRunId: run.id,
      run,
      timestamp: createTimestamp(),
    });

    const execution = captureWorkspaceExecutionContext(automation.config.workspaceId);
    const promise = runWithWorkspaceExecutionContext(execution, () => this.executeRun(automation, run));
    this.trackRun(run.id, promise);
    run = {
      ...run,
      status: "scheduled",
      updatedAt: createTimestamp(),
    };
    return run;
  }

  async recordStartFailure(
    automation: Automation,
    trigger: AutomationRunTrigger,
    options: { scheduledFor?: string } = {},
    error: unknown,
  ): Promise<AutomationRun> {
    const scheduledFor = options.scheduledFor ?? createTimestamp();
    const run = createRunFromAutomation(automation, trigger, scheduledFor);
    const now = createTimestamp();
    const runError = {
      message: isDomainError(error) ? error.message : String(error),
      timestamp: now,
      code: isDomainError(error) ? error.code : "automation_run_start_failed",
    };
    const failedRun: AutomationRun = {
      ...run,
      status: "failed",
      completedAt: now,
      error: runError,
      updatedAt: now,
    };
    await saveAutomationRun(failedRun, {
      transcriptChanges: {
        ...createTranscriptChangeSet(failedRun),
        revision: `${failedRun.updatedAt}:0`,
      },
    });
    automationEventEmitter.emit({
      type: "automation.run.failed",
      automationId: automation.config.id,
      automationRunId: failedRun.id,
      message: runError.message,
      timestamp: now,
    });
    automationEventEmitter.emit({
      type: "automation.run.status",
      automationId: automation.config.id,
      automationRunId: failedRun.id,
      status: failedRun.status,
      timestamp: now,
    });
    await this.clearAutomationRunning(automation.config.id, failedRun);
    return failedRun;
  }

  async interruptRun(run: AutomationRun, reason = "Automation run interrupted"): Promise<AutomationRun> {
    this.activeRunControllers.get(run.id)?.controller.abort();
    if (!run.chatId) {
      if (this.activeRunControllers.has(run.id)) {
        const now = createTimestamp();
        const updated: AutomationRun = {
          ...run,
          status: "interrupted",
          completedAt: now,
          error: {
            message: reason,
            timestamp: now,
            code: "interrupted",
          },
          updatedAt: now,
        };
        await saveAutomationRun(updated, {
          transcriptChanges: createTranscriptChangeSet(updated),
        });
        return updated;
      }
      throw new DomainError(
        "automation_run_not_ready",
        "Automation run cannot be interrupted because its chat has not been created yet",
        { details: { runId: run.id } },
      );
    }
    const chat = await chatManager.interruptChat(run.chatId, reason);
    if (!chat) {
      throw new DomainError(
        "automation_chat_not_found",
        "Automation run chat was not found",
        { details: { runId: run.id, chatId: run.chatId } },
      );
    }
    const streamPersistence = this.activeRunPersistences.get(run.id);
    const now = createTimestamp();
    const updated: AutomationRun = {
      ...run,
      status: "interrupted",
      completedAt: now,
      error: {
        message: reason,
        timestamp: now,
        code: "interrupted",
      },
      messages: chat?.state.messages ?? run.messages,
      logs: isAutomationCodeEnabled(run.configSnapshot)
        ? streamPersistence?.currentRun.logs ?? run.logs
        : chat?.state.logs ?? run.logs,
      toolCalls: chat?.state.toolCalls ?? run.toolCalls,
      pendingPermissionRequests: chat?.state.pendingPermissionRequests ?? run.pendingPermissionRequests,
      session: chat?.state.session ?? run.session,
      worktree: chat?.state.worktree ?? run.worktree,
      updatedAt: now,
    };
    if (streamPersistence) {
      await streamPersistence.adoptRun(updated);
    } else {
      await saveAutomationRun(updated, {
        transcriptChanges: createTranscriptChangeSet(updated),
      });
    }
    return updated;
  }

  private async setAutomationRunning(automation: Automation, runId: string): Promise<void> {
    const current = await loadAutomation(automation.config.id);
    const source = current ?? automation;
    await saveAutomation({
      config: {
        ...source.config,
        updatedAt: createTimestamp(),
      },
      state: {
        ...source.state,
        status: "running",
        activeRunId: runId,
        lastRunAt: createTimestamp(),
        lastError: undefined,
      },
    });
  }

  private async clearAutomationRunning(automationId: string, run: AutomationRun): Promise<void> {
    const current = await loadAutomation(automationId);
    if (!current) {
      return;
    }
    const failed = run.status === "failed";
    await saveAutomation({
      config: {
        ...current.config,
        updatedAt: createTimestamp(),
      },
      state: {
        ...current.state,
        status: current.config.enabled ? (failed ? "error" : "enabled") : "paused",
        activeRunId: current.state.activeRunId === run.id ? undefined : current.state.activeRunId,
        lastError: failed ? run.error : undefined,
      },
    });
  }

  private async executeRun(automation: Automation, run: AutomationRun, recoveredChat?: Chat): Promise<AutomationRun> {
    const abortController = new AbortController();
    const observer = new AbortController();
    this.activeRunControllers.set(run.id, { controller: abortController, observer, owner: requireExecutionOwnerUser() });
    let currentRun = run;
    if (!recoveredChat) {
      await this.setAutomationRunning(automation, run.id);
      currentRun = { ...run, status: "starting", startedAt: createTimestamp(), updatedAt: createTimestamp() };
      await saveAutomationRun(currentRun, { transcriptChanges: createTranscriptChangeSet(currentRun) });
    }

    let chatId: string | null = null;
    let unsubscribeChatEvents: (() => void) | undefined;
    let output: DeterministicAutomationOutput | undefined;
    let streamPersistence: AutomationRunStreamPersistence | undefined;
    try {
      if (abortController.signal.aborted) {
        throw new Error("Automation run interrupted");
      }
      const chat = recoveredChat ?? await chatManager.createAutomationRunChat({
        name: `Automation: ${automation.config.name}`,
        workspaceId: automation.config.workspaceId,
        modelProviderID: automation.config.model.providerID,
        modelID: automation.config.model.modelID,
        modelVariant: automation.config.model.variant,
        useWorktree: automation.config.useWorktree,
        baseBranch: automation.config.baseBranch,
        repositoryBases: automation.config.repositoryBases,
        directory: automation.config.directory,
        syncBaseBranch: true,
        prepareWorktreeOnCreate: true,
      });
      chatId = chat.config.id;
      if (abortController.signal.aborted) {
        await chatManager.deleteChat(chatId);
        chatId = null;
        throw new Error("Automation run interrupted");
      }
      unsubscribeChatEvents = chatEventEmitter.subscribe((event: ChatEvent) => {
        if (event.chatId !== chatId || !isAutomationChatEvent(event)) {
          return;
        }
        streamPersistence?.handleChatEvent(event);
        if (event.type === "chat.interrupted") observer.abort(REMOTE_RUN_INTERRUPTED);
        const streamPosition = streamPersistence?.streamPosition;
        if (event.type === "chat.message") {
          automationEventEmitter.emit({
            streamPosition,
            type: "automation.run.message",
            automationId: automation.config.id,
            automationRunId: currentRun.id,
            message: event.message,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.message.delta") {
          automationEventEmitter.emit({
            streamPosition,
            type: "automation.run.message.delta",
            automationId: automation.config.id,
            automationRunId: currentRun.id,
            messageId: event.messageId,
            role: event.role,
            delta: event.delta,
            baseLength: event.baseLength,
            contentLength: event.contentLength,
            messageTimestamp: event.messageTimestamp,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.log") {
          automationEventEmitter.emit({
            streamPosition,
            type: "automation.run.log",
            automationId: automation.config.id,
            automationRunId: currentRun.id,
            log: event.log,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.log.delta") {
          automationEventEmitter.emit({
            streamPosition,
            type: "automation.run.log.delta",
            automationId: automation.config.id,
            automationRunId: currentRun.id,
            logId: event.logId,
            level: event.level,
            message: event.message,
            logKind: event.logKind,
            delta: event.delta,
            baseLength: event.baseLength,
            contentLength: event.contentLength,
            logTimestamp: event.logTimestamp,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.tool_call") {
          automationEventEmitter.emit({
            streamPosition,
            type: "automation.run.tool_call",
            automationId: automation.config.id,
            automationRunId: currentRun.id,
            tool: event.tool,
            timestamp: event.timestamp,
          });
          return;
        }
      });
      currentRun = {
        ...currentRun,
        ...(recoveredChat ? {
          messages: chat.state.messages, logs: chat.state.logs, toolCalls: chat.state.toolCalls,
          pendingPermissionRequests: chat.state.pendingPermissionRequests,
        } : {}),
        chatId,
        status: "running",
        session: chat.state.session,
        worktree: chat.state.worktree,
        updatedAt: createTimestamp(),
      };
      streamPersistence = new AutomationRunStreamPersistence(currentRun);
      this.activeRunPersistences.set(currentRun.id, streamPersistence);
      await streamPersistence.persist();
      if (abortController.signal.aborted) {
        throw new Error("Automation run interrupted");
      }
      if (!recoveredChat) {
        automationEventEmitter.emit({
          type: "automation.run.started",
          automationId: automation.config.id,
          automationRunId: currentRun.id,
          run: currentRun,
          timestamp: createTimestamp(),
        });
      }
      automationEventEmitter.emit({
        type: "automation.run.status",
        automationId: automation.config.id,
        automationRunId: currentRun.id,
        status: currentRun.status,
        timestamp: createTimestamp(),
      });

      const codeMode = isAutomationCodeEnabled(currentRun.configSnapshot);
      output = codeMode
        ? new DeterministicAutomationOutput(currentRun, {
          persist: false,
          onAppend: (entry) => {
            streamPersistence?.handleOutputLog(entry);
            return streamPersistence?.streamPosition;
          },
        })
        : undefined;
      if (!recoveredChat && codeMode && output) {
        if (abortController.signal.aborted) {
          throw new Error("Automation run interrupted");
        }
        await executeDeterministicAutomation({
          run: currentRun,
          code: currentRun.configSnapshot.code!,
          chatId,
          workspaceId: automation.config.workspaceId,
          directory: chat.state.worktree?.worktreePath ?? chat.config.directory,
          signal: abortController.signal,
          output,
        });
        currentRun = await output.flush();
      } else if (!recoveredChat) {
        if (abortController.signal.aborted) {
          throw new Error("Automation run interrupted");
        }
        await chatManager.sendMessage(chatId, {
          message: automation.config.prompt,
          attachments: currentRun.attachments,
        });
      }
      const observingRemote = hasRemoteChatContinuity(await chatManager.getChatSummary(chatId) ?? chat);
      const completedChat = await chatManager.waitForChatIdle(
        chatId, observingRemote ? Number.POSITIVE_INFINITY : undefined, observingRemote ? observer.signal : undefined,
      ).catch(async (error: unknown) => {
        if (!observingRemote || observer.signal.reason !== REMOTE_RUN_INTERRUPTED) throw error;
        const interrupted = await chatManager.getChat(chat.config.id);
        if (!interrupted) throw new DomainError("automation_chat_not_found", "The interrupted automation conversation is unavailable.");
        return interrupted;
      });
      const interrupted = abortController.signal.aborted || completedChat.state.error?.code === "interrupted"
        || observingRemote && observer.signal.reason === REMOTE_RUN_INTERRUPTED;
      if (!interrupted && completedChat.state.harness?.remoteExecutionLost) {
        throw new DomainError("automation_execution_lost", "The worker lost the automation's live execution. Cold history recovery does not establish successful completion; the prompt was not repeated.");
      }
      if (!interrupted && recoveredChat && completedChat.state.harness?.inputs?.some((receipt) => receipt.admission.status === "unknown")) {
        throw new DomainError("automation_input_unconfirmed", "The automation input has no authoritative delivery receipt and was not repeated.");
      }
      const now = createTimestamp();
      const failed = !interrupted && (completedChat.state.status === "failed" || completedChat.state.error !== undefined);
      const completedRun: AutomationRun = {
        ...currentRun,
        status: interrupted ? "interrupted" : failed ? "failed" : "completed",
        completedAt: now,
        error: completedChat.state.error
          ? {
              message: completedChat.state.error.message,
              timestamp: completedChat.state.error.timestamp,
              code: completedChat.state.error.code,
            }
          : undefined,
        session: completedChat.state.session,
        worktree: completedChat.state.worktree,
        messages: completedChat.state.messages,
        logs: codeMode ? mergeRunLogs(completedChat.state.logs, currentRun.logs) : completedChat.state.logs,
        toolCalls: completedChat.state.toolCalls,
        pendingPermissionRequests: completedChat.state.pendingPermissionRequests,
        updatedAt: now,
      };
      if (streamPersistence) {
        await streamPersistence.adoptRun(completedRun);
      } else {
        await saveAutomationRun(completedRun, {
          transcriptChanges: createTranscriptChangeSet(completedRun),
        });
      }
      if (completedRun.status === "interrupted") {
        automationEventEmitter.emit({
          type: "automation.run.interrupted",
          automationId: automation.config.id,
          automationRunId: completedRun.id,
          timestamp: now,
        });
      } else if (completedRun.status === "failed") {
        automationEventEmitter.emit({
          type: "automation.run.failed",
          automationId: automation.config.id,
          automationRunId: completedRun.id,
          message: completedRun.error?.message ?? "Automation run failed",
          timestamp: now,
        });
      } else {
        automationEventEmitter.emit({
          type: "automation.run.completed",
          automationId: automation.config.id,
          automationRunId: completedRun.id,
          run: completedRun,
          timestamp: now,
        });
      }
      automationEventEmitter.emit({
        type: "automation.run.status",
        automationId: automation.config.id,
        automationRunId: completedRun.id,
        status: completedRun.status,
        timestamp: now,
      });
      await this.clearAutomationRunning(automation.config.id, completedRun);
      return completedRun;
    } catch (error) {
      if (observer.signal.reason === REMOTE_RUN_SUSPENDED) {
        await streamPersistence?.persist();
        return streamPersistence?.currentRun ?? currentRun;
      }
      log.error("Automation run failed", {
        automationId: automation.config.id,
        runId: currentRun.id,
        chatId,
        error: String(error),
      });
      const now = createTimestamp();
      if (output) {
        currentRun = output.run;
        try {
          await output.flush();
        } catch (flushError) {
          log.error("Failed to flush deterministic automation output", {
            automationId: automation.config.id,
            runId: currentRun.id,
            error: String(flushError),
          });
        }
      }
      const failedRun: AutomationRun = {
        ...currentRun,
        status: abortController.signal.aborted ? "interrupted" : "failed",
        completedAt: now,
        error: {
          message: abortController.signal.aborted ? "Automation run interrupted" : String(error),
          timestamp: now,
          ...(abortController.signal.aborted ? { code: "interrupted" }
            : error instanceof DomainError ? { code: error.code } : {}),
        },
        updatedAt: now,
      };
      if (streamPersistence) {
        await streamPersistence.adoptRun(failedRun);
      } else {
        await saveAutomationRun(failedRun, {
          transcriptChanges: createTranscriptChangeSet(failedRun),
        });
      }
      if (failedRun.status === "interrupted") {
        automationEventEmitter.emit({
          type: "automation.run.interrupted",
          automationId: automation.config.id,
          automationRunId: failedRun.id,
          timestamp: now,
        });
      } else {
        automationEventEmitter.emit({
          type: "automation.run.failed",
          automationId: automation.config.id,
          automationRunId: failedRun.id,
          message: failedRun.error?.message ?? "Automation run failed",
          timestamp: now,
        });
      }
      automationEventEmitter.emit({
        type: "automation.run.status",
        automationId: automation.config.id,
        automationRunId: failedRun.id,
        status: failedRun.status,
        timestamp: now,
      });
      await this.clearAutomationRunning(automation.config.id, failedRun);
      return failedRun;
    } finally {
      unsubscribeChatEvents?.();
      this.activeRunControllers.delete(run.id);
      this.activeRunPersistences.delete(run.id);
    }
  }
}

export const automationRunner = new AutomationRunner();
