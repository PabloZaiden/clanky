import type { Agent, AgentConfig, AgentRun, AgentRunStatus } from "@/shared/agent";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { createInitialAgentState, isAgentRunActiveStatus } from "@/shared/agent";
import { createTimestamp } from "@/shared/events";
import { DomainError } from "./domain-error";
import { getWorkspace, touchWorkspace } from "../persistence/workspaces";
import {
  deleteAgent,
  deleteAgentRun,
  deleteAgentRuns,
  listAgentRuns,
  listAgents,
  listAgentsByWorkspace,
  listActiveAgentRuns,
  loadAgent,
  loadAgentRun,
  saveAgent,
} from "../persistence/agents";
import { chatManager } from "./chat-manager";
import { agentRunner } from "./agent-runner";
import { calculateNextRunAt } from "./agent-schedule";
import { agentEventEmitter } from "./event-emitter";

const INTERRUPT_CHAT_ID_WAIT_MS = 2000;
const INTERRUPT_CHAT_ID_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAgentOptions {
  name: string;
  workspaceId: string;
  prompt: string;
  model: AgentConfig["model"];
  baseBranch?: string;
  useWorktree: boolean;
  schedule: Omit<AgentConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
}

export interface UpdateAgentOptions {
  name?: string;
  prompt?: string;
  model?: AgentConfig["model"];
  baseBranch?: string | null;
  useWorktree?: boolean;
  schedule?: Omit<AgentConfig["schedule"], "nextRunAt"> & { nextRunAt?: string };
  enabled?: boolean;
  isPrivate?: boolean;
}

export interface ListAgentRunsOptions {
  limit?: number;
  offset?: number;
}

export interface PurgeAgentRunsOptions {
  before?: string;
  statuses?: AgentRunStatus[];
}

export class AgentManager {
  private async waitForInterruptibleRun(runId: string): Promise<AgentRun | null> {
    const deadline = Date.now() + INTERRUPT_CHAT_ID_WAIT_MS;
    while (Date.now() <= deadline) {
      const run = await loadAgentRun(runId);
      if (!run || !isAgentRunActiveStatus(run.status)) {
        return null;
      }
      if (run.chatId) {
        return run;
      }
      await delay(INTERRUPT_CHAT_ID_POLL_MS);
    }

    const run = await loadAgentRun(runId);
    if (!run || !isAgentRunActiveStatus(run.status)) {
      return null;
    }
    if (run.chatId) {
      return run;
    }
    throw new DomainError(
      "agent_run_not_ready",
      "Agent run cannot be interrupted until its chat has been created",
      { details: { runId } },
    );
  }

  async createAgent(options: CreateAgentOptions): Promise<Agent> {
    const workspace = await getWorkspace(options.workspaceId);
    if (!workspace) {
      throw new DomainError("workspace_not_found", "Workspace not found", {
        details: { workspaceId: options.workspaceId },
      });
    }
    const now = createTimestamp();
    const nextRunAt = options.schedule.nextRunAt
      ?? calculateNextRunAt(options.schedule);
    const enabled = options.enabled ?? true;
    const config: AgentConfig = {
      id: crypto.randomUUID(),
      name: options.name.trim(),
      workspaceId: options.workspaceId,
      directory: workspace.directory,
      prompt: options.prompt,
      model: options.model,
      baseBranch: options.baseBranch,
      useWorktree: options.useWorktree,
      schedule: {
        ...options.schedule,
        nextRunAt,
      },
      enabled,
      createdAt: now,
      updatedAt: now,
      mode: "agent",
    };
    const agent: Agent = {
      config,
      state: {
        ...createInitialAgentState(config.id, enabled ? nextRunAt : undefined),
        status: enabled ? "enabled" : "paused",
      },
    };
    await saveAgent(agent);
    await touchWorkspace(options.workspaceId);
    agentEventEmitter.emit({
      type: "agent.created",
      agentId: agent.config.id,
      agent,
      timestamp: now,
    });
    return agent;
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return loadAgent(agentId);
  }

  async getAgents(workspaceId?: string): Promise<Agent[]> {
    return workspaceId ? listAgentsByWorkspace(workspaceId) : listAgents();
  }

  async updateAgent(agentId: string, updates: UpdateAgentOptions): Promise<Agent | null> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      return null;
    }
    const nextSchedule = updates.schedule
      ? {
          ...updates.schedule,
          nextRunAt: updates.schedule.nextRunAt ?? calculateNextRunAt(updates.schedule),
        }
      : agent.config.schedule;
    const enabled = updates.enabled ?? agent.config.enabled;
    const updated: Agent = {
      config: {
        ...agent.config,
        name: updates.name?.trim() ?? agent.config.name,
        prompt: updates.prompt ?? agent.config.prompt,
        model: updates.model ?? agent.config.model,
        baseBranch: updates.baseBranch === null ? undefined : updates.baseBranch ?? agent.config.baseBranch,
        useWorktree: updates.useWorktree ?? agent.config.useWorktree,
        schedule: nextSchedule,
        enabled,
        isPrivate: updates.isPrivate ?? agent.config.isPrivate,
        updatedAt: createTimestamp(),
      },
      state: {
        ...agent.state,
        status: agent.state.activeRunId ? "running" : enabled ? "enabled" : "paused",
        nextRunAt: enabled ? nextSchedule.nextRunAt : undefined,
      },
    };
    await saveAgent(updated);
    agentEventEmitter.emit({
      type: "agent.updated",
      agentId,
      agent: updated,
      timestamp: createTimestamp(),
    });
    return updated;
  }

  async pauseAgent(agentId: string): Promise<Agent | null> {
    return this.updateAgent(agentId, { enabled: false });
  }

  async resumeAgent(agentId: string): Promise<Agent | null> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      return null;
    }
    return this.updateAgent(agentId, {
      enabled: true,
      schedule: {
        ...agent.config.schedule,
        nextRunAt: calculateNextRunAt(agent.config.schedule),
      },
    });
  }

  async runNow(agentId: string, attachments: MessageImageAttachment[] = []): Promise<AgentRun> {
    const agent = await loadAgent(agentId);
    if (!agent) {
      throw new DomainError("agent_not_found", "Agent not found", {
        details: { agentId },
      });
    }
    const activeRuns = await listActiveAgentRuns(agentId);
    if (activeRuns.length > 0 || agent.state.activeRunId) {
      throw new DomainError("agent_already_running", "Agent already has an active run", {
        details: { agentId },
      });
    }
    return agentRunner.startAgentRun(agent, "manual", { attachments });
  }

  async interruptAgent(agentId: string, reason?: string): Promise<AgentRun | null> {
    const agent = await loadAgent(agentId);
    if (!agent?.state.activeRunId) {
      return null;
    }
    const run = await this.waitForInterruptibleRun(agent.state.activeRunId);
    if (!run) {
      return null;
    }
    const interrupted = await agentRunner.interruptRun(run, reason);
    await saveAgent({
      config: {
        ...agent.config,
        updatedAt: createTimestamp(),
      },
      state: {
        ...agent.state,
        status: agent.config.enabled ? "enabled" : "paused",
        activeRunId: undefined,
      },
    });
    agentEventEmitter.emit({
      type: "agent.run.interrupted",
      agentId,
      agentRunId: interrupted.id,
      timestamp: createTimestamp(),
    });
    return interrupted;
  }

  async listRuns(agentId: string, options: ListAgentRunsOptions = {}): Promise<AgentRun[]> {
    return listAgentRuns(agentId, options);
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    return loadAgentRun(runId);
  }

  async deleteRun(runId: string): Promise<boolean> {
    const run = await loadAgentRun(runId);
    if (!run) {
      return false;
    }
    await chatManager.deleteChat(run.chatId ?? run.id);
    const deleted = await deleteAgentRun(runId);
    if (deleted) {
      agentEventEmitter.emit({
        type: "agent.run.deleted",
        agentId: run.agentId,
        agentRunId: runId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }

  async purgeRuns(agentId: string, options: PurgeAgentRunsOptions = {}): Promise<string[]> {
    const runs = await listAgentRuns(agentId, { limit: 10000, offset: 0 });
    const selectedRuns = runs.filter((run) => {
      if (options.before && run.createdAt >= options.before) {
        return false;
      }
      if (options.statuses && options.statuses.length > 0 && !options.statuses.includes(run.status)) {
        return false;
      }
      return run.status !== "starting" && run.status !== "running" && run.status !== "scheduled";
    });
    for (const run of selectedRuns) {
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    const deletedRunIds = await deleteAgentRuns(agentId, {
      before: options.before,
      statuses: options.statuses,
    });
    if (deletedRunIds.length > 0) {
      agentEventEmitter.emit({
        type: "agent.runs.purged",
        agentId,
        deletedRunIds,
        timestamp: createTimestamp(),
      });
    }
    return deletedRunIds;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    const runs = await listAgentRuns(agentId, { limit: 10000, offset: 0 });
    for (const run of runs) {
      if (run.status === "starting" || run.status === "running" || run.status === "scheduled") {
        await agentRunner.interruptRun(run, "Agent deleted");
      }
      await chatManager.deleteChat(run.chatId ?? run.id);
    }
    const deleted = await deleteAgent(agentId);
    if (deleted) {
      agentEventEmitter.emit({
        type: "agent.deleted",
        agentId,
        timestamp: createTimestamp(),
      });
    }
    return deleted;
  }
}

export const agentManager = new AgentManager();
