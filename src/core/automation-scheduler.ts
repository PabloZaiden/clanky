import type { Automation, AutomationRun } from "@/shared/automation";
import { createTimestamp } from "@/shared/events";
import {
  listActiveAutomationRuns,
  listAutomations,
  listDueAutomations,
  loadAutomation,
  saveAutomation,
  saveAutomationRun,
} from "../persistence/automations";
import { createLogger } from "@pablozaiden/webapp/server";
import { automationEventEmitter } from "./event-emitter";
import { automationRunner } from "./automation-runner";
import { calculateNextRunAt } from "./automation-schedule";
import { runForEachActiveUser } from "./background-users";

const log = createLogger("automation-scheduler");
const POLL_INTERVAL_MS = 5000;

function createSkippedRun(automation: Automation, scheduledFor: string, skipReason: string): AutomationRun {
  const now = createTimestamp();
  return {
    id: crypto.randomUUID(),
    automationId: automation.config.id,
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
      name: automation.config.name,
      workspaceId: automation.config.workspaceId,
      directory: automation.config.directory,
      prompt: automation.config.prompt,
      model: automation.config.model,
      baseBranch: automation.config.baseBranch,
      useWorktree: automation.config.useWorktree,
      schedule: automation.config.schedule,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export class AutomationScheduler {
  private timer: Timer | null = null;
  private ticking = false;

  start(): void {
    if (this.timer) {
      return;
    }
    void runForEachActiveUser(async () => {
      await this.reconcileStaleRuns();
    }).then(() => this.tick()).catch((error) => {
      log.error("Failed to start automation scheduler", { error: String(error) });
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    log.info("Automation scheduler started");
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    log.info("Automation scheduler stopped");
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await runForEachActiveUser(async () => {
        const dueAutomations = await listDueAutomations(now.toISOString());
        for (const automation of dueAutomations) {
          await this.processDueAutomation(automation, now);
        }
      });
    } catch (error) {
      log.error("Automation scheduler tick failed", { error: String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileStaleRuns(): Promise<void> {
    const automations = await listAutomations();
    const now = createTimestamp();
    for (const automation of automations) {
      const activeRuns = await listActiveAutomationRuns(automation.config.id);
      if (activeRuns.length === 0 && !automation.state.activeRunId) {
        continue;
      }
      for (const run of activeRuns) {
        await saveAutomationRun({
          ...run,
          status: "failed",
          completedAt: now,
          error: {
            message: "Automation run was interrupted by server restart",
            timestamp: now,
            code: "server_restart",
          },
          updatedAt: now,
        });
      }
      await saveAutomation({
        config: {
          ...automation.config,
          updatedAt: now,
        },
        state: {
          ...automation.state,
          status: automation.config.enabled ? "enabled" : "paused",
          activeRunId: undefined,
          lastError: activeRuns.length > 0
            ? {
                message: "Automation run was interrupted by server restart",
                timestamp: now,
                code: "server_restart",
              }
            : automation.state.lastError,
        },
      });
    }
  }

  private async processDueAutomation(automation: Automation, now: Date): Promise<void> {
    const scheduledFor = automation.config.schedule.nextRunAt;
    const nextRunAt = calculateNextRunAt(automation.config.schedule, now);
    const latest = await loadAutomation(automation.config.id);
    if (!latest || !latest.config.enabled) {
      return;
    }

    const activeRuns = await listActiveAutomationRuns(automation.config.id);
    if (activeRuns.length > 0 || latest.state.activeRunId) {
      const skippedRun = createSkippedRun(latest, scheduledFor, "Previous automation run is still active");
      await saveAutomationRun(skippedRun);
      automationEventEmitter.emit({
        type: "automation.run.skipped",
        automationId: latest.config.id,
        automationRunId: skippedRun.id,
        reason: skippedRun.skipReason ?? "Previous automation run is still active",
        timestamp: createTimestamp(),
      });
      await saveAutomation({
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

    const updatedAutomation: Automation = {
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
    await saveAutomation(updatedAutomation);
    await automationRunner.startAutomationRun(latest, "schedule", { scheduledFor }).catch((error) => {
      log.error("Scheduled automation run failed unexpectedly", {
        automationId: latest.config.id,
        error: String(error),
      });
      return automationRunner.recordStartFailure(latest, "schedule", { scheduledFor }, error);
    });
  }
}

export const automationScheduler = new AutomationScheduler();
