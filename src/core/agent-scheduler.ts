import type { Agent, AgentRun } from "../types/agent";
import { createTimestamp } from "../types/events";
import {
  listActiveAgentRuns,
  listAgents,
  listDueAgents,
  loadAgent,
  saveAgent,
  saveAgentRun,
} from "../persistence/agents";
import { createLogger } from "./logger";
import { agentEventEmitter } from "./event-emitter";
import { agentRunner } from "./agent-runner";
import { calculateNextRunAt } from "./agent-schedule";

const log = createLogger("agent-scheduler");
const POLL_INTERVAL_MS = 5000;

function createSkippedRun(agent: Agent, scheduledFor: string, skipReason: string): AgentRun {
  const now = createTimestamp();
  return {
    id: crypto.randomUUID(),
    agentId: agent.config.id,
    status: "skipped",
    trigger: "schedule",
    scheduledFor,
    completedAt: now,
    skipReason,
    messages: [],
    logs: [],
    toolCalls: [],
    pendingPermissionRequests: [],
    configSnapshot: {
      name: agent.config.name,
      workspaceId: agent.config.workspaceId,
      directory: agent.config.directory,
      prompt: agent.config.prompt,
      model: agent.config.model,
      baseBranch: agent.config.baseBranch,
      useWorktree: agent.config.useWorktree,
      schedule: agent.config.schedule,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export class AgentScheduler {
  private timer: Timer | null = null;
  private ticking = false;

  start(): void {
    if (this.timer) {
      return;
    }
    void this.reconcileStaleRuns().then(() => this.tick()).catch((error) => {
      log.error("Failed to start agent scheduler", { error: String(error) });
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    log.info("Agent scheduler started");
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    log.info("Agent scheduler stopped");
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const dueAgents = await listDueAgents(now.toISOString());
      for (const agent of dueAgents) {
        await this.processDueAgent(agent, now);
      }
    } catch (error) {
      log.error("Agent scheduler tick failed", { error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileStaleRuns(): Promise<void> {
    const agents = await listAgents();
    const now = createTimestamp();
    for (const agent of agents) {
      const activeRuns = await listActiveAgentRuns(agent.config.id);
      if (activeRuns.length === 0 && !agent.state.activeRunId) {
        continue;
      }
      for (const run of activeRuns) {
        await saveAgentRun({
          ...run,
          status: "failed",
          completedAt: now,
          error: {
            message: "Agent run was interrupted by server restart",
            timestamp: now,
            code: "server_restart",
          },
          updatedAt: now,
        });
      }
      await saveAgent({
        config: {
          ...agent.config,
          updatedAt: now,
        },
        state: {
          ...agent.state,
          status: agent.config.enabled ? "enabled" : "paused",
          activeRunId: undefined,
          lastError: activeRuns.length > 0
            ? {
                message: "Agent run was interrupted by server restart",
                timestamp: now,
                code: "server_restart",
              }
            : agent.state.lastError,
        },
      });
    }
  }

  private async processDueAgent(agent: Agent, now: Date): Promise<void> {
    const scheduledFor = agent.config.schedule.nextRunAt;
    const nextRunAt = calculateNextRunAt(agent.config.schedule, now);
    const latest = await loadAgent(agent.config.id);
    if (!latest || !latest.config.enabled) {
      return;
    }

    const activeRuns = await listActiveAgentRuns(agent.config.id);
    if (activeRuns.length > 0 || latest.state.activeRunId) {
      const skippedRun = createSkippedRun(latest, scheduledFor, "Previous agent run is still active");
      await saveAgentRun(skippedRun);
      agentEventEmitter.emit({
        type: "agent.run.skipped",
        agentId: latest.config.id,
        agentRunId: skippedRun.id,
        reason: skippedRun.skipReason ?? "Previous agent run is still active",
        timestamp: createTimestamp(),
      });
      await saveAgent({
        config: {
          ...latest.config,
          schedule: {
            ...latest.config.schedule,
            nextRunAt,
          },
          updatedAt: createTimestamp(),
        },
        state: {
          ...latest.state,
          lastSkippedAt: createTimestamp(),
          nextRunAt,
        },
      });
      return;
    }

    const updatedAgent: Agent = {
      config: {
        ...latest.config,
        schedule: {
          ...latest.config.schedule,
          nextRunAt,
        },
        updatedAt: createTimestamp(),
      },
      state: {
        ...latest.state,
        nextRunAt,
      },
    };
    await saveAgent(updatedAgent);
    await agentRunner.startAgentRun(latest, "schedule", { scheduledFor }).catch((error) => {
      log.error("Scheduled agent run failed unexpectedly", {
        agentId: latest.config.id,
        error: String(error),
      });
    });
  }
}

export const agentScheduler = new AgentScheduler();
