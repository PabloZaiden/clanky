/**
 * Background monitor for pushed loops waiting on external pull request merges.
 */

import type { Loop } from "../types/loop";
import type { CommandExecutor } from "./command-executor";
import type { PullRequestNavigationGitService } from "./pull-request-navigation";
import { listLoops, loadLoop, updateLoopState } from "../persistence/loops";
import { backendManager } from "./backend-manager";
import { GitService } from "./git-service";
import { createLogger } from "./logger";
import { getLoopWorkingDirectory, loopManager } from "./loop-manager";
import { probePullRequestMonitoring } from "./pull-request-navigation";

const log = createLogger("core:pushed-loop-monitor");

const DEFAULT_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const MINIMUM_MONITOR_INTERVAL_MS = 60 * 1000;

function getMonitorIntervalMs(): number {
  const rawValue = process.env["RALPHER_PUSHED_LOOP_MONITOR_INTERVAL_MS"];
  if (!rawValue) {
    return DEFAULT_MONITOR_INTERVAL_MS;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < MINIMUM_MONITOR_INTERVAL_MS) {
    log.warn("Invalid pushed loop monitor interval, using default", {
      rawValue,
      minimumMs: MINIMUM_MONITOR_INTERVAL_MS,
      defaultMs: DEFAULT_MONITOR_INTERVAL_MS,
    });
    return DEFAULT_MONITOR_INTERVAL_MS;
  }

  return parsedValue;
}

function isEligibleForMonitoring(loop: Loop): boolean {
  return loop.state.status === "pushed" && loop.state.reviewMode?.addressable === true;
}

export interface PushedLoopMonitorDependencies {
  listLoops: () => Promise<Loop[]>;
  loadLoop: (loopId: string) => Promise<Loop | null>;
  updateLoopState: (loopId: string, state: Loop["state"]) => Promise<boolean>;
  getCommandExecutor: (workspaceId: string, directory: string) => Promise<CommandExecutor>;
  createGitService: (executor: CommandExecutor) => PullRequestNavigationGitService;
  markMerged: (loopId: string) => Promise<{ success: boolean; error?: string }>;
  intervalMs: number;
}

export class PushedLoopMonitor {
  private readonly deps: PushedLoopMonitorDependencies;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  constructor(dependencies?: Partial<PushedLoopMonitorDependencies>) {
    this.deps = {
      listLoops,
      loadLoop,
      updateLoopState,
      getCommandExecutor: (workspaceId: string, directory: string) =>
        backendManager.getCommandExecutorAsync(workspaceId, directory),
      createGitService: (executor: CommandExecutor) => GitService.withExecutor(executor),
      markMerged: (loopId: string) => loopManager.markMerged(loopId),
      intervalMs: getMonitorIntervalMs(),
      ...dependencies,
    };
  }

  start(): void {
    if (this.intervalId !== undefined) {
      return;
    }

    log.info("Starting pushed loop monitor", {
      intervalMs: this.deps.intervalMs,
    });
    this.intervalId = setInterval(() => {
      void this.runNow();
    }, this.deps.intervalMs);

    void this.runNow();
  }

  stop(_closeActiveConnections?: boolean): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async runNow(): Promise<void> {
    if (this.isRunning) {
      log.debug("Skipping pushed loop monitor run because a previous run is still active");
      return;
    }

    this.isRunning = true;
    try {
      const loops = await this.deps.listLoops();
      for (const loop of loops) {
        if (!isEligibleForMonitoring(loop)) {
          continue;
        }
        await this.monitorLoop(loop);
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async monitorLoop(loop: Loop): Promise<void> {
    const workingDirectory = getLoopWorkingDirectory(loop);
    if (!workingDirectory) {
      await this.persistMonitoringState(loop.config.id, {
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        lastError: "Loop is configured to use a worktree, but no worktree path is available.",
      });
      return;
    }

    try {
      const executor = await this.deps.getCommandExecutor(loop.config.workspaceId, workingDirectory);
      const git = this.deps.createGitService(executor);
      const monitoringState = await probePullRequestMonitoring(loop, workingDirectory, executor, git);
      await this.persistMonitoringState(loop.config.id, monitoringState);

      if (monitoringState.status === "merged") {
        const latestLoop = await this.deps.loadLoop(loop.config.id);
        if (latestLoop?.state.status !== "pushed" || latestLoop.state.reviewMode?.addressable !== true) {
          return;
        }

        const result = await this.deps.markMerged(loop.config.id);
        if (!result.success) {
          log.warn("Failed to auto-mark loop as merged after merged PR detection", {
            loopId: loop.config.id,
            error: result.error,
          });
        }
      }
    } catch (error) {
      log.error("Failed to monitor pushed loop", {
        loopId: loop.config.id,
        error: String(error),
      });
      await this.persistMonitoringState(loop.config.id, {
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        lastError: String(error),
      });
    }
  }

  private async persistMonitoringState(
    loopId: string,
    monitoringState: Loop["state"]["pullRequestMonitoring"],
  ): Promise<void> {
    if (!monitoringState) {
      return;
    }

    const latestLoop = await this.deps.loadLoop(loopId);
    if (!latestLoop || latestLoop.state.status !== "pushed") {
      return;
    }

    const updatedState = {
      ...latestLoop.state,
      pullRequestMonitoring: monitoringState,
    };
    await this.deps.updateLoopState(loopId, updatedState);
  }
}

export const pushedLoopMonitor = new PushedLoopMonitor();
