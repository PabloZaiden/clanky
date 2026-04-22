/**
 * Background monitor for pushed loops waiting on external pull request merges.
 */

import type { Loop } from "../types/loop";
import type { CommandExecutor } from "./command-executor";
import type { PullRequestNavigationGitService } from "./pull-request-navigation";
import type { LoopEvent } from "../types/events";
import type {
  AutomaticPrFlowFeedbackItem,
  AutomaticPrFlowPullRequest,
  AutomaticPrFlowSnapshot,
} from "./automatic-pr-flow-github";
import type { AutomaticPrFlowExtractedFeedbackItem, AutomaticPrFlowFeedbackExtractionResult } from "./automatic-pr-feedback";
import type { PushLoopResult } from "./loop-manager";
import { listLoops, loadLoop, updateLoopState } from "../persistence/loops";
import { backendManager } from "./backend-manager";
import { loopEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { GitService } from "./git-service";
import { createLogger } from "./logger";
import { getLoopWorkingDirectory, loopManager } from "./loop-manager";
import { emitAutomaticPrFlowUpdatedEvent } from "./loop/loop-automatic-pr-flow-events";
import { probePullRequestMonitoring } from "./pull-request-navigation";
import {
  ensureAutomaticPrFlowPullRequest,
  fetchAutomaticPrFlowSnapshot,
  resolveAutomaticPrFlowReviewThread,
} from "./automatic-pr-flow-github";
import { extractAutomaticPrFeedback } from "./automatic-pr-feedback";

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
  if (loop.state.reviewMode?.addressable !== true) {
    return false;
  }

  if (loop.state.status === "pushed") {
    return true;
  }

  return loop.state.automaticPrFlow?.enabled === true && loop.state.automaticPrFlow.activeBatch !== undefined;
}

export interface PushedLoopMonitorDependencies {
  listLoops: () => Promise<Loop[]>;
  loadLoop: (loopId: string) => Promise<Loop | null>;
  updateLoopState: (loopId: string, state: Loop["state"]) => Promise<boolean>;
  emitter: SimpleEventEmitter<LoopEvent>;
  getCommandExecutor: (workspaceId: string, directory: string) => Promise<CommandExecutor>;
  createGitService: (executor: CommandExecutor) => PullRequestNavigationGitService;
  markMerged: (loopId: string) => Promise<{ success: boolean; error?: string }>;
  pushLoop: (loopId: string) => Promise<PushLoopResult>;
  updateBranch: (loopId: string) => Promise<PushLoopResult>;
  isLoopRunning: (loopId: string) => boolean;
  probePullRequestMonitoring: (
    loop: Loop,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<NonNullable<Loop["state"]["pullRequestMonitoring"]>>;
  ensureAutomaticPrFlowPullRequest: (
    loop: Loop,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<AutomaticPrFlowPullRequest>;
  fetchAutomaticPrFlowSnapshot: (
    pullRequest: AutomaticPrFlowPullRequest,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<AutomaticPrFlowSnapshot>;
  extractAutomaticPrFeedback: (
    loop: Loop,
    directory: string,
    feedbackItems: AutomaticPrFlowFeedbackItem[],
  ) => Promise<AutomaticPrFlowFeedbackExtractionResult>;
  startAutomaticPrReviewCycle: (
    loopId: string,
    options: {
      batchId: string;
      sourceItems: AutomaticPrFlowFeedbackItem[];
      feedbackItems: AutomaticPrFlowExtractedFeedbackItem[];
    },
  ) => Promise<{ success: boolean; error?: string; reviewCycle?: number; branch?: string; commentIds?: string[] }>;
  resolveAutomaticPrFlowReviewThread: (
    threadId: string,
    directory: string,
    executor: CommandExecutor,
  ) => Promise<void>;
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
      emitter: loopEventEmitter,
      getCommandExecutor: (workspaceId: string, directory: string) =>
        backendManager.getCommandExecutorAsync(workspaceId, directory),
      createGitService: (executor: CommandExecutor) => GitService.withExecutor(executor),
      markMerged: (loopId: string) => loopManager.markMerged(loopId),
      pushLoop: (loopId: string) => loopManager.pushLoop(loopId),
      updateBranch: (loopId: string) => loopManager.updateBranch(loopId),
      isLoopRunning: (loopId: string) => loopManager.isRunning(loopId),
      probePullRequestMonitoring,
      ensureAutomaticPrFlowPullRequest,
      fetchAutomaticPrFlowSnapshot,
      extractAutomaticPrFeedback,
      startAutomaticPrReviewCycle: (loopId: string, options) => loopManager.startAutomaticPrReviewCycle(loopId, options),
      resolveAutomaticPrFlowReviewThread,
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
    } catch (error) {
      log.error("Pushed loop monitor run failed", {
        error: String(error),
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async monitorLoop(loop: Loop): Promise<void> {
    const automaticPrFlowEnabled = loop.state.automaticPrFlow?.enabled === true;
    const workingDirectory = getLoopWorkingDirectory(loop);
    if (!workingDirectory) {
      const now = new Date().toISOString();
      await this.persistLoopMonitoringState(
        loop.config.id,
        {
          status: "error",
          lastCheckedAt: now,
          lastError: "Loop is configured to use a worktree, but no worktree path is available.",
        },
        automaticPrFlowEnabled
          ? this.buildAutomaticPrFlowErrorState(loop.state.automaticPrFlow, now, "Loop is configured to use a worktree, but no worktree path is available.")
          : undefined,
      );
      return;
    }

    try {
      const executor = await this.deps.getCommandExecutor(loop.config.workspaceId, workingDirectory);
      const git = this.deps.createGitService(executor);
      let monitoringState = await this.deps.probePullRequestMonitoring(loop, workingDirectory, executor, git);
      let automaticPrFlowState: Loop["state"]["automaticPrFlow"];

      if (automaticPrFlowEnabled) {
        try {
          const automaticPrFlowResult = await this.monitorAutomaticPrFlow(loop, workingDirectory, executor, git);
          automaticPrFlowState = automaticPrFlowResult.automaticPrFlowState;
          monitoringState = automaticPrFlowResult.monitoringState ?? monitoringState;
        } catch (error) {
          automaticPrFlowState = this.buildAutomaticPrFlowErrorState(
            loop.state.automaticPrFlow,
            new Date().toISOString(),
            String(error),
          );
        }
      }

      await this.persistLoopMonitoringState(loop.config.id, monitoringState, automaticPrFlowState);

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
      const now = new Date().toISOString();
      await this.persistLoopMonitoringState(
        loop.config.id,
        {
          status: "error",
          lastCheckedAt: now,
          lastError: String(error),
        },
        automaticPrFlowEnabled
          ? this.buildAutomaticPrFlowErrorState(loop.state.automaticPrFlow, now, String(error))
          : undefined,
      );
    }
  }

  private async monitorAutomaticPrFlow(
    loop: Loop,
    workingDirectory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ): Promise<{
    automaticPrFlowState: NonNullable<Loop["state"]["automaticPrFlow"]>;
    monitoringState?: NonNullable<Loop["state"]["pullRequestMonitoring"]>;
  }> {
    const previousState = loop.state.automaticPrFlow;
    if (!previousState?.enabled) {
      throw new Error("Automatic PR flow is not enabled for this loop.");
    }

    const now = new Date().toISOString();
    const handledItems = Array.isArray(previousState.handledItems) ? previousState.handledItems : [];
    const pullRequest = await this.deps.ensureAutomaticPrFlowPullRequest(loop, workingDirectory, executor, git);
    const activeBatchStatus = previousState.activeBatch ? this.getAutomaticPrFlowBatchStatus(loop) : undefined;
    const baseState: NonNullable<Loop["state"]["automaticPrFlow"]> = {
      enabled: true,
      status: activeBatchStatus === "finalizing_feedback" ? "finalizing_feedback" : previousState.activeBatch ? "processing_feedback" : "monitoring",
      startedAt: previousState.startedAt,
      updatedAt: now,
      lastCheckedAt: now,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      activeBatch: previousState.activeBatch,
      handledItems,
      stoppedAt: undefined,
    };

    if (previousState.activeBatch) {
      if (activeBatchStatus === "processing_feedback" || activeBatchStatus === "finalizing_feedback") {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: activeBatchStatus,
          },
          monitoringState: this.mergeMonitoringStateFromPullRequest(loop.state.pullRequestMonitoring, pullRequest, now),
        };
      }

      if (loop.state.status === "completed") {
        const finalizeResult = await this.deps.pushLoop(loop.config.id);
        if (!finalizeResult.success) {
          throw new Error(finalizeResult.error ?? "Automatic PR review cycle failed to push updated changes.");
        }

        if (finalizeResult.syncStatus === "conflicts_being_resolved") {
          return {
            automaticPrFlowState: {
              ...baseState,
              status: "finalizing_feedback",
            },
            monitoringState: this.mergeMonitoringStateFromPullRequest(loop.state.pullRequestMonitoring, pullRequest, now),
          };
        }
      } else if (loop.state.status !== "pushed") {
        throw new Error(this.describeAutomaticPrBatchFailure(loop.state.status));
      }

      const resolvedState = await this.resolveAutomaticPrFlowBatch(previousState, workingDirectory, executor);
      return {
        automaticPrFlowState: {
          ...baseState,
          status: "monitoring",
          activeBatch: undefined,
          handledItems: resolvedState.handledItems,
          updatedAt: resolvedState.updatedAt,
          lastCheckedAt: resolvedState.lastCheckedAt,
        },
        monitoringState: this.mergeMonitoringStateFromPullRequest(loop.state.pullRequestMonitoring, pullRequest, now),
      };
    }

    const snapshot = await this.deps.fetchAutomaticPrFlowSnapshot(pullRequest, workingDirectory, executor, git);
    const monitoringState = this.mergeMonitoringStateFromSnapshot(loop.state.pullRequestMonitoring, snapshot, now);
    if (this.shouldTriggerAutomaticBranchUpdate(loop, monitoringState, now)) {
      const requestedMonitoringState = {
        ...monitoringState,
        branchUpdate: {
          status: "requested" as const,
          lastDetectedAt: now,
          lastTriggeredAt: now,
        },
      };
      const updateResult = await this.deps.updateBranch(loop.config.id);
      if (!updateResult.success) {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
          },
          monitoringState: {
            ...requestedMonitoringState,
            lastError: updateResult.error ?? "Automatic PR branch update failed.",
            branchUpdate: {
              ...requestedMonitoringState.branchUpdate,
              status: "failed",
              lastError: updateResult.error ?? "Automatic PR branch update failed.",
            },
          },
        };
      }

      if (updateResult.syncStatus === "conflicts_being_resolved") {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
          },
          monitoringState: {
            ...requestedMonitoringState,
            branchUpdate: {
              ...requestedMonitoringState.branchUpdate,
              status: "conflicts",
            },
          },
        };
      }

      return {
        automaticPrFlowState: {
          ...baseState,
          status: "monitoring",
        },
        monitoringState: requestedMonitoringState,
      };
    }

    const pendingFeedbackItems = snapshot.actionableItems.filter(
      (item) => !handledItems.some((handledItem) => handledItem.id === item.id),
    );
    if (pendingFeedbackItems.length > 0) {
      const extractedFeedback = await this.deps.extractAutomaticPrFeedback(loop, workingDirectory, pendingFeedbackItems);
      const sourceItemIds = new Set(
        extractedFeedback.feedbackItems.flatMap((item) => item.sourceItemIds),
      );
      const sourceItems = pendingFeedbackItems.filter((item) => sourceItemIds.has(item.id));
      const ignoredItemIds = new Set(
        extractedFeedback.ignoredItems.map((ignoredItem) => ignoredItem.itemId),
      );
      const ignoredHandledItems = pendingFeedbackItems
        .filter((item) => ignoredItemIds.has(item.id))
        .map((item) => ({
          id: item.id,
          source: item.source,
          outcome: "ignored" as const,
          handledAt: now,
        }));
      const nextHandledItems = [...handledItems, ...ignoredHandledItems];

      if (sourceItems.length === 0 || extractedFeedback.feedbackItems.length === 0) {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
            handledItems: nextHandledItems,
          },
          monitoringState,
        };
      }

      const batchId = crypto.randomUUID();
      const result = await this.deps.startAutomaticPrReviewCycle(loop.config.id, {
        batchId,
        sourceItems,
        feedbackItems: extractedFeedback.feedbackItems,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Automatic PR review cycle failed to start.");
      }

      return {
        automaticPrFlowState: {
          ...baseState,
          status: "processing_feedback",
          handledItems: nextHandledItems,
          activeBatch: {
            batchId,
            itemIds: sourceItems.map((item) => item.id),
            items: sourceItems.map((item) => ({
              id: item.id,
              source: item.source,
              threadId: item.threadId,
            })),
            startedAt: now,
            reviewCycle: result.reviewCycle,
          },
        },
        monitoringState,
      };
    }

    return {
      automaticPrFlowState: {
        ...baseState,
        status: "monitoring",
      },
      monitoringState,
    };
  }

  private async resolveAutomaticPrFlowBatch(
    automaticPrFlowState: NonNullable<Loop["state"]["automaticPrFlow"]>,
    workingDirectory: string,
    executor: CommandExecutor,
  ): Promise<NonNullable<Loop["state"]["automaticPrFlow"]>> {
    const activeBatch = automaticPrFlowState.activeBatch;
    if (!activeBatch) {
      return automaticPrFlowState;
    }

    const now = new Date().toISOString();
    const handledItems = Array.isArray(automaticPrFlowState.handledItems)
      ? automaticPrFlowState.handledItems
      : [];
    for (const item of activeBatch.items) {
      if (item.source === "review_thread") {
        await this.deps.resolveAutomaticPrFlowReviewThread(item.threadId ?? item.id, workingDirectory, executor);
      }
    }

    const newlyHandledItems: NonNullable<Loop["state"]["automaticPrFlow"]>["handledItems"] = activeBatch.items.map((item) => ({
      id: item.id,
      source: item.source,
      outcome: item.source === "review_thread" ? "resolved" : "manual",
      handledAt: now,
    }));

    return {
      ...automaticPrFlowState,
      status: "monitoring",
      updatedAt: now,
      lastCheckedAt: now,
      lastError: undefined,
      activeBatch: undefined,
      handledItems: [...handledItems, ...newlyHandledItems],
    };
  }

  private mergeMonitoringStateFromSnapshot(
    currentState: Loop["state"]["pullRequestMonitoring"],
    snapshot: AutomaticPrFlowSnapshot,
    now: string,
  ): NonNullable<Loop["state"]["pullRequestMonitoring"]> {
    return this.mergeMonitoringStateFromPullRequest(currentState, snapshot.pullRequest, now);
  }

  private mergeMonitoringStateFromPullRequest(
    currentState: Loop["state"]["pullRequestMonitoring"],
    pullRequest: AutomaticPrFlowPullRequest,
    now: string,
  ): NonNullable<Loop["state"]["pullRequestMonitoring"]> {
    const nextStatus = pullRequest.state === "MERGED"
      ? "merged"
      : pullRequest.state === "CLOSED"
        ? "closed"
        : "open";

    const branchUpdate = nextStatus === "open" && pullRequest.mergeStateStatus === "BEHIND"
      ? {
          status: currentState?.branchUpdate?.status ?? "required",
          lastDetectedAt: now,
          lastTriggeredAt: currentState?.branchUpdate?.lastTriggeredAt,
          lastError: currentState?.branchUpdate?.lastError,
        }
      : undefined;

    return {
      status: nextStatus,
      lastCheckedAt: now,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      mergedAt: pullRequest.state === "MERGED" ? (pullRequest.mergedAt ?? currentState?.mergedAt ?? now) : undefined,
      mergeStateStatus: pullRequest.mergeStateStatus,
      viewerCanUpdateBranch: pullRequest.viewerCanUpdateBranch,
      branchUpdate,
      lastError: undefined,
    };
  }

  private shouldTriggerAutomaticBranchUpdate(
    loop: Loop,
    monitoringState: NonNullable<Loop["state"]["pullRequestMonitoring"]>,
    now: string,
  ): boolean {
    if (loop.state.status !== "pushed") {
      return false;
    }

    if (monitoringState.status !== "open" || monitoringState.mergeStateStatus !== "BEHIND") {
      return false;
    }

    if (this.deps.isLoopRunning(loop.config.id)) {
      return false;
    }

    const branchUpdate = monitoringState.branchUpdate;
    if (!branchUpdate?.lastTriggeredAt || branchUpdate.status !== "requested") {
      return true;
    }

    const lastTriggeredAt = Date.parse(branchUpdate.lastTriggeredAt);
    const currentTime = Date.parse(now);
    if (!Number.isFinite(lastTriggeredAt) || !Number.isFinite(currentTime)) {
      return true;
    }

    return currentTime - lastTriggeredAt >= this.deps.intervalMs;
  }

  private buildAutomaticPrFlowErrorState(
    currentState: Loop["state"]["automaticPrFlow"],
    now: string,
    error: string,
  ): NonNullable<Loop["state"]["automaticPrFlow"]> {
    return {
      enabled: true,
      status: "error",
      startedAt: currentState?.startedAt ?? now,
      updatedAt: now,
      lastCheckedAt: now,
      pullRequestNumber: currentState?.pullRequestNumber,
      pullRequestUrl: currentState?.pullRequestUrl,
      activeBatch: currentState?.activeBatch,
      handledItems: currentState?.handledItems ?? [],
      lastError: error,
      stoppedAt: currentState?.stoppedAt,
    };
  }

  private async persistLoopMonitoringState(
    loopId: string,
    monitoringState: NonNullable<Loop["state"]["pullRequestMonitoring"]> | undefined,
    automaticPrFlowState?: Loop["state"]["automaticPrFlow"],
  ): Promise<void> {
    if (!monitoringState && !automaticPrFlowState) {
      return;
    }

    const latestLoop = await this.deps.loadLoop(loopId);
    if (!latestLoop) {
      return;
    }

    const hasActiveAutomaticBatch = automaticPrFlowState?.activeBatch !== undefined
      || latestLoop.state.automaticPrFlow?.activeBatch !== undefined;
    const hasTrackedBranchUpdate = monitoringState?.branchUpdate !== undefined
      || latestLoop.state.pullRequestMonitoring?.branchUpdate !== undefined;
    if (latestLoop.state.status !== "pushed" && !hasActiveAutomaticBatch && !hasTrackedBranchUpdate) {
      return;
    }

    const updatedState = {
      ...latestLoop.state,
      pullRequestMonitoring: monitoringState ?? latestLoop.state.pullRequestMonitoring,
      automaticPrFlow: automaticPrFlowState ?? latestLoop.state.automaticPrFlow,
    };
    await this.deps.updateLoopState(loopId, updatedState);
    if (automaticPrFlowState !== undefined) {
      emitAutomaticPrFlowUpdatedEvent(this.deps.emitter, loopId, updatedState.automaticPrFlow);
    }
  }

  private getAutomaticPrFlowBatchStatus(
    loop: Loop,
  ): "processing_feedback" | "finalizing_feedback" | "ready_to_finalize" | "ready_to_resolve" {
    if (loop.state.status === "resolving_conflicts") {
      return "finalizing_feedback";
    }

    if (this.deps.isLoopRunning(loop.config.id)) {
      return "processing_feedback";
    }

    if (loop.state.status === "pushed") {
      return "ready_to_resolve";
    }

    if (
      loop.state.status === "idle"
      || loop.state.status === "starting"
      || loop.state.status === "running"
      || loop.state.status === "waiting"
    ) {
      return "processing_feedback";
    }

    if (loop.state.status === "completed") {
      return "ready_to_finalize";
    }

    return "ready_to_finalize";
  }

  private describeAutomaticPrBatchFailure(status: Loop["state"]["status"]): string {
    switch (status) {
      case "max_iterations":
        return "Automatic PR review cycle reached max_iterations before the updated branch could be pushed.";
      case "failed":
        return "Automatic PR review cycle failed before the updated branch could be pushed.";
      case "stopped":
        return "Automatic PR review cycle was stopped before the updated branch could be pushed.";
      case "deleted":
        return "Automatic PR review cycle loop was deleted before the updated branch could be pushed.";
      case "merged":
        return "Automatic PR review cycle ended in an unexpected merged state before the updated branch could be pushed.";
      default:
        return `Automatic PR review cycle ended in unexpected status: ${status}`;
    }
  }
}

export const pushedLoopMonitor = new PushedLoopMonitor();
