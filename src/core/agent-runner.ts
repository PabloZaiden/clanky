import type { Agent, AgentRun, AgentRunTrigger } from "@/shared/agent";
import { isAgentCodeEnabled } from "@/shared/agent";
import type { ChatEvent } from "@/shared";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { createTimestamp } from "@/shared/events";
import { DomainError } from "./domain-error";
import { chatManager } from "./chat-manager";
import {
  loadAgent,
  saveAgent,
  saveAgentRun,
} from "../persistence/agents";
import { createLogger } from "@pablozaiden/webapp/server";
import { agentEventEmitter, chatEventEmitter } from "./event-emitter";
import { executeDeterministicAgent } from "./deterministic-agent-runtime";
import { DeterministicAgentOutput } from "./deterministic-agent-output";
import { MAX_PERSISTED_LOGS } from "./engine/engine-types";

const log = createLogger("agent-runner");

function isAgentChatEvent(event: ChatEvent): boolean {
  if ("scope" in event) {
    return event.scope === "agent";
  }
  if (event.type === "chat.created") {
    return event.config.scope === "agent";
  }
  if (event.type === "chat.updated") {
    return event.chat.config.scope === "agent";
  }
  return false;
}

function createRunFromAgent(
  agent: Agent,
  trigger: AgentRunTrigger,
  scheduledFor: string,
  attachments: MessageImageAttachment[] = [],
): AgentRun {
  const now = createTimestamp();
  return {
    id: crypto.randomUUID(),
    agentId: agent.config.id,
    status: "scheduled",
    trigger,
    scheduledFor,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    attachments,
    configSnapshot: {
      name: agent.config.name,
      workspaceId: agent.config.workspaceId,
      directory: agent.config.directory,
      prompt: agent.config.prompt,
      code: agent.config.code,
      model: agent.config.model,
      baseBranch: agent.config.baseBranch,
      useWorktree: agent.config.useWorktree,
      schedule: agent.config.schedule,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function mergeRunLogs(chatLogs: AgentRun["logs"], outputLogs: AgentRun["logs"]): AgentRun["logs"] {
  const byId = new Map<string, AgentRun["logs"][number]>();
  for (const logEntry of [...chatLogs, ...outputLogs]) {
    byId.set(logEntry.id, logEntry);
  }
  return [...byId.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_PERSISTED_LOGS);
}

export class AgentRunner {
  private readonly activeRuns = new Map<string, Promise<AgentRun>>();
  private readonly activeRunControllers = new Map<string, AbortController>();

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  async runAgent(
    agent: Agent,
    trigger: AgentRunTrigger,
    options: {
      scheduledFor?: string;
      attachments?: MessageImageAttachment[];
    } = {},
  ): Promise<AgentRun> {
    const run = await this.startAgentRun(agent, trigger, options);
    const activeRun = this.activeRuns.get(run.id);
    if (!activeRun) {
      return run;
    }
    return activeRun;
  }

  async startAgentRun(
    agent: Agent,
    trigger: AgentRunTrigger,
    options: {
      scheduledFor?: string;
      attachments?: MessageImageAttachment[];
    } = {},
  ): Promise<AgentRun> {
    const scheduledFor = options.scheduledFor ?? createTimestamp();
    let run = createRunFromAgent(agent, trigger, scheduledFor, options.attachments);
    await saveAgentRun(run);
    agentEventEmitter.emit({
      type: "agent.run.scheduled",
      agentId: agent.config.id,
      agentRunId: run.id,
      run,
      timestamp: createTimestamp(),
    });

    const promise = this.executeRun(agent, run);
    this.activeRuns.set(run.id, promise);
    promise.finally(() => {
      this.activeRuns.delete(run.id);
    });
    run = {
      ...run,
      status: "scheduled",
      updatedAt: createTimestamp(),
    };
    return run;
  }

  async interruptRun(run: AgentRun, reason = "Agent run interrupted"): Promise<AgentRun> {
    this.activeRunControllers.get(run.id)?.abort();
    if (!run.chatId) {
      if (this.activeRunControllers.has(run.id)) {
        const now = createTimestamp();
        const updated: AgentRun = {
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
        await saveAgentRun(updated);
        return updated;
      }
      throw new DomainError(
        "agent_run_not_ready",
        "Agent run cannot be interrupted because its chat has not been created yet",
        { details: { runId: run.id } },
      );
    }
    const chat = await chatManager.interruptChat(run.chatId, reason);
    if (!chat) {
      throw new DomainError(
        "agent_chat_not_found",
        "Agent run chat was not found",
        { details: { runId: run.id, chatId: run.chatId } },
      );
    }
    const now = createTimestamp();
    const updated: AgentRun = {
      ...run,
      status: "interrupted",
      completedAt: now,
      error: {
        message: reason,
        timestamp: now,
        code: "interrupted",
      },
      messages: chat?.state.messages ?? run.messages,
      logs: isAgentCodeEnabled(run.configSnapshot) ? run.logs : chat?.state.logs ?? run.logs,
      toolCalls: chat?.state.toolCalls ?? run.toolCalls,
      pendingPermissionRequests: chat?.state.pendingPermissionRequests ?? run.pendingPermissionRequests,
      session: chat?.state.session ?? run.session,
      worktree: chat?.state.worktree ?? run.worktree,
      updatedAt: now,
    };
    await saveAgentRun(updated);
    return updated;
  }

  private async setAgentRunning(agent: Agent, runId: string): Promise<void> {
    const current = await loadAgent(agent.config.id);
    const source = current ?? agent;
    await saveAgent({
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

  private async clearAgentRunning(agentId: string, run: AgentRun): Promise<void> {
    const current = await loadAgent(agentId);
    if (!current) {
      return;
    }
    const failed = run.status === "failed";
    await saveAgent({
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

  private async executeRun(agent: Agent, run: AgentRun): Promise<AgentRun> {
    const abortController = new AbortController();
    this.activeRunControllers.set(run.id, abortController);
    await this.setAgentRunning(agent, run.id);
    let currentRun: AgentRun = {
      ...run,
      status: "starting",
      startedAt: createTimestamp(),
      updatedAt: createTimestamp(),
    };
    await saveAgentRun(currentRun);

    let chatId: string | null = null;
    let unsubscribeChatEvents: (() => void) | undefined;
    let output: DeterministicAgentOutput | undefined;
    try {
      if (abortController.signal.aborted) {
        throw new Error("Agent run interrupted");
      }
      const chat = await chatManager.createAgentRunChat({
        name: `Agent: ${agent.config.name}`,
        workspaceId: agent.config.workspaceId,
        modelProviderID: agent.config.model.providerID,
        modelID: agent.config.model.modelID,
        modelVariant: agent.config.model.variant,
        useWorktree: agent.config.useWorktree,
        baseBranch: agent.config.baseBranch,
        directory: agent.config.directory,
        syncBaseBranch: true,
        prepareWorktreeOnCreate: true,
      });
      chatId = chat.config.id;
      if (abortController.signal.aborted) {
        await chatManager.deleteChat(chatId);
        chatId = null;
        throw new Error("Agent run interrupted");
      }
      unsubscribeChatEvents = chatEventEmitter.subscribe((event: ChatEvent) => {
        if (event.chatId !== chatId || !isAgentChatEvent(event)) {
          return;
        }
        if (event.type === "chat.message") {
          agentEventEmitter.emit({
            type: "agent.run.message",
            agentId: agent.config.id,
            agentRunId: currentRun.id,
            message: event.message,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.log") {
          agentEventEmitter.emit({
            type: "agent.run.log",
            agentId: agent.config.id,
            agentRunId: currentRun.id,
            log: event.log,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.tool_call") {
          agentEventEmitter.emit({
            type: "agent.run.tool_call",
            agentId: agent.config.id,
            agentRunId: currentRun.id,
            tool: event.tool,
            timestamp: event.timestamp,
          });
          return;
        }
        if (event.type === "chat.tool_call.extra") {
          agentEventEmitter.emit({
            type: "agent.run.tool_call.extra",
            agentId: agent.config.id,
            agentRunId: currentRun.id,
            toolId: event.toolId,
            extra: event.extra,
            timestamp: event.timestamp,
          });
        }
      });
      currentRun = {
        ...currentRun,
        chatId,
        status: "running",
        session: chat.state.session,
        worktree: chat.state.worktree,
        updatedAt: createTimestamp(),
      };
      await saveAgentRun(currentRun);
      if (abortController.signal.aborted) {
        throw new Error("Agent run interrupted");
      }
      agentEventEmitter.emit({
        type: "agent.run.started",
        agentId: agent.config.id,
        agentRunId: currentRun.id,
        run: currentRun,
        timestamp: createTimestamp(),
      });
      agentEventEmitter.emit({
        type: "agent.run.status",
        agentId: agent.config.id,
        agentRunId: currentRun.id,
        status: currentRun.status,
        timestamp: createTimestamp(),
      });

      const codeMode = isAgentCodeEnabled(currentRun.configSnapshot);
      output = codeMode ? new DeterministicAgentOutput(currentRun) : undefined;
      if (codeMode && output) {
        if (abortController.signal.aborted) {
          throw new Error("Agent run interrupted");
        }
        await executeDeterministicAgent({
          run: currentRun,
          code: currentRun.configSnapshot.code!,
          chatId,
          workspaceId: agent.config.workspaceId,
          directory: chat.state.worktree?.worktreePath ?? chat.config.directory,
          signal: abortController.signal,
          output,
        });
        currentRun = await output.flush();
      } else {
        if (abortController.signal.aborted) {
          throw new Error("Agent run interrupted");
        }
        await chatManager.sendMessage(chatId, {
          message: agent.config.prompt,
          attachments: currentRun.attachments,
        });
      }
      const completedChat = await chatManager.waitForChatIdle(chatId);
      const now = createTimestamp();
      const interrupted = abortController.signal.aborted || completedChat.state.error?.code === "interrupted";
      const failed = !interrupted && (completedChat.state.status === "failed" || completedChat.state.error !== undefined);
      const completedRun: AgentRun = {
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
      await saveAgentRun(completedRun);
      if (completedRun.status === "interrupted") {
        agentEventEmitter.emit({
          type: "agent.run.interrupted",
          agentId: agent.config.id,
          agentRunId: completedRun.id,
          timestamp: now,
        });
      } else if (completedRun.status === "failed") {
        agentEventEmitter.emit({
          type: "agent.run.failed",
          agentId: agent.config.id,
          agentRunId: completedRun.id,
          message: completedRun.error?.message ?? "Agent run failed",
          timestamp: now,
        });
      } else {
        agentEventEmitter.emit({
          type: "agent.run.completed",
          agentId: agent.config.id,
          agentRunId: completedRun.id,
          run: completedRun,
          timestamp: now,
        });
      }
      agentEventEmitter.emit({
        type: "agent.run.status",
        agentId: agent.config.id,
        agentRunId: completedRun.id,
        status: completedRun.status,
        timestamp: now,
      });
      await this.clearAgentRunning(agent.config.id, completedRun);
      return completedRun;
    } catch (error) {
      log.error("Agent run failed", {
        agentId: agent.config.id,
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
          log.error("Failed to flush deterministic agent output", {
            agentId: agent.config.id,
            runId: currentRun.id,
            error: String(flushError),
          });
        }
      }
      const failedRun: AgentRun = {
        ...currentRun,
        status: abortController.signal.aborted ? "interrupted" : "failed",
        completedAt: now,
        error: {
          message: abortController.signal.aborted ? "Agent run interrupted" : String(error),
          timestamp: now,
          ...(abortController.signal.aborted ? { code: "interrupted" } : {}),
        },
        updatedAt: now,
      };
      await saveAgentRun(failedRun);
      if (failedRun.status === "interrupted") {
        agentEventEmitter.emit({
          type: "agent.run.interrupted",
          agentId: agent.config.id,
          agentRunId: failedRun.id,
          timestamp: now,
        });
      } else {
        agentEventEmitter.emit({
          type: "agent.run.failed",
          agentId: agent.config.id,
          agentRunId: failedRun.id,
          message: failedRun.error?.message ?? "Agent run failed",
          timestamp: now,
        });
      }
      agentEventEmitter.emit({
        type: "agent.run.status",
        agentId: agent.config.id,
        agentRunId: failedRun.id,
        status: failedRun.status,
        timestamp: now,
      });
      await this.clearAgentRunning(agent.config.id, failedRun);
      return failedRun;
    } finally {
      unsubscribeChatEvents?.();
      this.activeRunControllers.delete(run.id);
    }
  }
}

export const agentRunner = new AgentRunner();
